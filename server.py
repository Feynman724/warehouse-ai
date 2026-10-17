#!/usr/bin/env python3
import json, os, re, sqlite3, sys, hashlib, hmac, secrets, threading, time
import base64
import vision
import batch
from datetime import datetime
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse, unquote

BASE=Path(__file__).resolve().parent
STATIC=BASE/'static'; DB=Path(os.environ.get('WAREHOUSE_DB', BASE/'data/warehouse.db'))
REFERENCES=BASE/'references'
REFERENCE_NAMES=('喇叭','帐篷','手电筒','扫帚','折叠桌','指示牌','椅子','水桶','画架','麦架')
HOST=os.environ.get('WAREHOUSE_HOST','127.0.0.1'); PORT=int(os.environ.get('WAREHOUSE_PORT','5188'))
ADMIN_PHONE=os.environ.get('ADMIN_PHONE','待配置')
SESSION_SECONDS=7*24*3600
VISION_LOCK=threading.Lock()
VISION_CALLS={}
LIVE_LOCK=threading.Lock()
LIVE_CALLS={}

def check_vision_rate(uid):
    with VISION_LOCK:
      recent=[t for t in VISION_CALLS.get(uid,[]) if time.monotonic()-t<60]
      if len(recent)>=12: raise ValueError('试拍过于频繁，请稍后再试')
      recent.append(time.monotonic());VISION_CALLS[uid]=recent

def check_live_rate(uid):
    with VISION_LOCK:
      recent=[t for t in LIVE_CALLS.get(uid,[]) if time.monotonic()-t<60]
      if len(recent)>=45 or (recent and time.monotonic()-recent[-1]<1.0):
        raise ValueError('实时识别请求过快，请稍后重试')
      recent.append(time.monotonic());LIVE_CALLS[uid]=recent

def now(): return datetime.now().isoformat(timespec='seconds')
def conn():
    c=sqlite3.connect(DB); c.row_factory=sqlite3.Row; c.execute('PRAGMA foreign_keys=ON'); return c

def password_hash(password, salt=None):
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac('sha256', password.encode(), salt, 210000)
    return f'pbkdf2_sha256$210000${salt.hex()}${digest.hex()}'

def password_ok(password, encoded):
    try:
      algorithm, rounds, salt, expected = encoded.split('$')
      actual = hashlib.pbkdf2_hmac('sha256', password.encode(), bytes.fromhex(salt), int(rounds)).hex()
      return algorithm == 'pbkdf2_sha256' and hmac.compare_digest(actual, expected)
    except Exception: return False

def init():
    DB.parent.mkdir(parents=True,exist_ok=True)
    with conn() as c:
      c.executescript('''
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT,role TEXT,phone TEXT,student_no TEXT,class_name TEXT,department TEXT,blacklisted INTEGER DEFAULT 0,blacklist_reason TEXT DEFAULT '',blacklisted_at TEXT,blacklisted_by TEXT);
      CREATE TABLE IF NOT EXISTS inventory(id TEXT PRIMARY KEY,name TEXT,category TEXT,total INTEGER,available INTEGER,damaged INTEGER DEFAULT 0,location TEXT);
      CREATE TABLE IF NOT EXISTS applications(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id TEXT,item_id TEXT,quantity INTEGER,borrow_date TEXT,return_date TEXT,purpose TEXT,status TEXT DEFAULT 'pending',decision_reason TEXT DEFAULT '',decided_by TEXT,created_at TEXT,updated_at TEXT,FOREIGN KEY(user_id) REFERENCES users(id),FOREIGN KEY(item_id) REFERENCES inventory(id));
      CREATE TABLE IF NOT EXISTS approval_history(id INTEGER PRIMARY KEY AUTOINCREMENT,application_id INTEGER,old_status TEXT,new_status TEXT,reason TEXT,operator_id TEXT,created_at TEXT);
      CREATE TABLE IF NOT EXISTS transactions(id INTEGER PRIMARY KEY AUTOINCREMENT,application_id INTEGER,action TEXT,photo TEXT,ai_item_id TEXT,ai_quantity INTEGER,final_item_id TEXT,final_quantity INTEGER,damage INTEGER DEFAULT 0,damage_type TEXT,damage_quantity INTEGER DEFAULT 0,damage_description TEXT,status TEXT DEFAULT 'pending_review',created_at TEXT,reviewed_at TEXT,reviewed_by TEXT);
      CREATE TABLE IF NOT EXISTS blacklist_history(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id TEXT,action TEXT,reason TEXT,operator_id TEXT,created_at TEXT);
      CREATE TABLE IF NOT EXISTS appeals(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id TEXT,content TEXT,status TEXT DEFAULT 'pending',reply TEXT DEFAULT '',created_at TEXT,handled_at TEXT,handled_by TEXT);
      CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id TEXT,created_at TEXT,expires_at INTEGER,FOREIGN KEY(user_id) REFERENCES users(id));
      CREATE TABLE IF NOT EXISTS stock_history(id INTEGER PRIMARY KEY AUTOINCREMENT,item_id TEXT,operation TEXT,before_total INTEGER,before_available INTEGER,after_total INTEGER,after_available INTEGER,delta INTEGER,reason TEXT,operator_id TEXT,created_at TEXT,FOREIGN KEY(item_id) REFERENCES inventory(id));
      ''')
      batch.init(c)
      columns={x['name'] for x in c.execute('PRAGMA table_info(users)').fetchall()}
      for name,sql in [('password_hash','TEXT DEFAULT ""'),('account_status','TEXT DEFAULT "active"'),('created_at','TEXT')]:
        if name not in columns: c.execute(f'ALTER TABLE users ADD COLUMN {name} {sql}')
      columns={x['name'] for x in c.execute('PRAGMA table_info(inventory)').fetchall()}
      for name,sql in [('spec','TEXT DEFAULT ""'),('unit','TEXT DEFAULT "件"'),('status','TEXT DEFAULT "active"')]:
        if name not in columns: c.execute(f'ALTER TABLE inventory ADD COLUMN {name} {sql}')
      columns={x['name'] for x in c.execute('PRAGMA table_info(transactions)').fetchall()}
      if 'vision_result' not in columns: c.execute('ALTER TABLE transactions ADD COLUMN vision_result TEXT DEFAULT ""')
      if not c.execute('SELECT 1 FROM users LIMIT 1').fetchone():
        c.executemany('INSERT INTO users(id,name,role,phone,student_no,class_name,department,blacklisted,blacklist_reason,blacklisted_at,blacklisted_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)',[
          ('u1','林同学','user','13800000000','3220100001','计科2301','宣传部',0,'',None,None),
          ('u2','陈同学','user','13900000000','3220100002','自动化2302','文艺部',0,'',None,None),
          ('admin','物资管理员','admin',ADMIN_PHONE,'','','物资管理部',0,'',None,None)])
      if not c.execute('SELECT 1 FROM inventory LIMIT 1').fetchone():
        c.executemany('INSERT INTO inventory(id,name,category,total,available,damaged,location) VALUES(?,?,?,?,?,?,?)',[
          ('table','折叠桌','桌椅类',12,10,0,'A 区 · 货架 01'),('chair','折叠椅','桌椅类',40,34,0,'A 区 · 货架 02'),('tent','四角帐篷','搭建类',8,6,0,'B 区 · 地面位 03')])
      demo=[('u1','Student123'),('u2','Student123'),('admin','Admin123')]
      c.execute("UPDATE users SET student_no='0000000001' WHERE id='admin' AND (student_no='' OR student_no IS NULL)")
      for user_id,password in demo:
        c.execute('UPDATE users SET password_hash=CASE WHEN password_hash="" OR password_hash IS NULL THEN ? ELSE password_hash END,account_status="active",created_at=COALESCE(created_at,?) WHERE id=?',(password_hash(password),now(),user_id))

def rows(q,args=()):
  with conn() as c:return [dict(x) for x in c.execute(q,args).fetchall()]
def one(q,args=()):
  with conn() as c:
    x=c.execute(q,args).fetchone();return dict(x) if x else None

def state(uid):
  user=one('SELECT * FROM users WHERE id=?',(uid,))
  if not user: raise ValueError('登录已失效')
  apps=rows('''SELECT a.*,u.name applicant,u.phone,u.student_no,u.class_name,u.department,i.name item_name,i.available
    FROM applications a JOIN users u ON u.id=a.user_id JOIN inventory i ON i.id=a.item_id
    WHERE (?='admin' OR a.user_id=?) ORDER BY a.id DESC''',(user['role'],user['id']))
  tx=rows('''SELECT t.*,a.user_id,u.name applicant,i.name item_name FROM transactions t JOIN applications a ON a.id=t.application_id JOIN users u ON u.id=a.user_id JOIN inventory i ON i.id=COALESCE(t.final_item_id,t.ai_item_id) ORDER BY t.id DESC''') if user['role']=='admin' else rows('''SELECT t.*,a.user_id,u.name applicant,i.name item_name FROM transactions t JOIN applications a ON a.id=t.application_id JOIN users u ON u.id=a.user_id JOIN inventory i ON i.id=COALESCE(t.final_item_id,t.ai_item_id) WHERE a.user_id=? ORDER BY t.id DESC''',(user['id'],))
  for record in tx:
    record['has_photo']=bool(record.pop('photo',None))
    record['vision_result']=json.loads(record['vision_result']) if record.get('vision_result') else None
  safe_user={k:v for k,v in user.items() if k!='password_hash'}
  result={'config':{'adminPhone':ADMIN_PHONE},'referenceCatalog':REFERENCE_NAMES,'currentUser':safe_user,'users':rows('SELECT id,name,role,phone,student_no,class_name,department,blacklisted,blacklist_reason,account_status,created_at FROM users WHERE role="user"') if user['role']=='admin' else [],'pendingAdmins':rows('SELECT id,name,phone,student_no,created_at FROM users WHERE role="admin" AND account_status="pending"') if user['role']=='admin' else [],'inventory':rows('SELECT * FROM inventory' if user['role']=='admin' else 'SELECT * FROM inventory WHERE status="active"'),'stockHistory':rows('SELECT h.*,i.name item_name,u.name operator FROM stock_history h JOIN inventory i ON i.id=h.item_id LEFT JOIN users u ON u.id=h.operator_id ORDER BY h.id DESC LIMIT 200') if user['role']=='admin' else [],'applications':apps,'transactions':tx,'history':rows('SELECT h.*,u.name operator FROM approval_history h LEFT JOIN users u ON u.id=h.operator_id ORDER BY h.id DESC'),'blacklistHistory':rows('SELECT h.*,u.name user_name,o.name operator FROM blacklist_history h JOIN users u ON u.id=h.user_id LEFT JOIN users o ON o.id=h.operator_id ORDER BY h.id DESC'),'appeals':rows('SELECT a.*,u.name user_name,u.blacklist_reason FROM appeals a JOIN users u ON u.id=a.user_id ORDER BY a.id DESC') if user['role']=='admin' else rows('SELECT * FROM appeals WHERE user_id=? ORDER BY id DESC',(user['id'],))}
  with conn() as c: result.update(batch.state(c,uid,user['role']=='admin'))
  return result

def need(data,*keys):
  for k in keys:
    if str(data.get(k,'')).strip()=='': raise ValueError(f'缺少必填字段：{k}')

def analyze_for_application(c,app,action,photo):
  items=[dict(x) for x in c.execute('SELECT * FROM inventory').fetchall()]
  before=None
  if action=='return':
    previous=c.execute('''SELECT t.photo FROM transactions t WHERE t.application_id=? AND t.action="borrow" AND t.status="confirmed" ORDER BY t.id DESC LIMIT 1''',(app['id'],)).fetchone()
    before=previous['photo'] if previous else None
  return vision.analyze(photo,items,app['item_id'],app['quantity'],before)

def mutate(path,d,uid):
  user=one('SELECT * FROM users WHERE id=?',(uid,));
  if not user: raise ValueError('用户不存在')
  if path=='/api/vision/live':
    if not d.get('photo'): raise ValueError('请提供当前画面')
    check_live_rate(uid)
    with LIVE_LOCK:
      return vision.detect_live(d['photo'])
  admin=user['role']=='admin'; t=now()
  with conn() as c:
    if path.startswith('/api/batch/'):
      return batch.mutate(c,path,d,user,t)
    if path=='/api/inventory/create':
      if not admin: raise ValueError('无管理员权限')
      need(d,'name','category','unit','initialQuantity')
      name=str(d['name']).strip(); category=str(d['category']).strip(); spec=str(d.get('spec','')).strip(); unit=str(d['unit']).strip(); location=str(d.get('location','')).strip()
      if any(len(x)>100 for x in (name,category,spec,unit,location)): raise ValueError('字段长度不能超过 100 字')
      if c.execute('SELECT 1 FROM inventory WHERE name=?',(name,)).fetchone(): raise ValueError('物资名称已存在')
      qty=int(d['initialQuantity'])
      if qty<0: raise ValueError('初始数量不能为负数')
      item_id='item_'+secrets.token_hex(6)
      c.execute('INSERT INTO inventory(id,name,category,total,available,damaged,location,spec,unit,status) VALUES(?,?,?,?,?,?,?,?,?,"active")',(item_id,name,category,qty,qty,0,location,spec,unit))
      c.execute('INSERT INTO stock_history(item_id,operation,before_total,before_available,after_total,after_available,delta,reason,operator_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',(item_id,'create',0,0,qty,qty,qty,'新增物资',uid,t))
    elif path=='/api/inventory/edit':
      if not admin: raise ValueError('无管理员权限')
      need(d,'id','name','category','unit')
      item=c.execute('SELECT * FROM inventory WHERE id=?',(d['id'],)).fetchone()
      if not item: raise ValueError('物资不存在')
      name=str(d['name']).strip(); category=str(d['category']).strip(); spec=str(d.get('spec','')).strip(); unit=str(d['unit']).strip(); location=str(d.get('location','')).strip()
      if any(len(x)>100 for x in (name,category,spec,unit,location)): raise ValueError('字段长度不能超过 100 字')
      if c.execute('SELECT 1 FROM inventory WHERE name=? AND id<>?',(name,item['id'])).fetchone(): raise ValueError('物资名称已存在')
      c.execute('UPDATE inventory SET name=?,category=?,spec=?,unit=?,location=? WHERE id=?',(name,category,spec,unit,location,item['id']))
      c.execute('INSERT INTO stock_history(item_id,operation,before_total,before_available,after_total,after_available,delta,reason,operator_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',(item['id'],'edit',item['total'],item['available'],item['total'],item['available'],0,'编辑物资资料',uid,t))
    elif path=='/api/inventory/adjust':
      if not admin: raise ValueError('无管理员权限')
      need(d,'id','direction','quantity','reason')
      item=c.execute('SELECT * FROM inventory WHERE id=?',(d['id'],)).fetchone()
      if not item: raise ValueError('物资不存在')
      if d['direction'] not in ('increase','decrease'): raise ValueError('调整方向无效')
      qty=int(d['quantity']); reason=str(d['reason']).strip()
      if qty<1: raise ValueError('调整数量必须大于 0')
      if len(reason)>500: raise ValueError('原因不能超过 500 字')
      delta=qty if d['direction']=='increase' else -qty
      if item['available']+delta<0: raise ValueError('减少数量超过可用库存；已借出或缺损数量不能扣减')
      c.execute('UPDATE inventory SET total=total+?,available=available+? WHERE id=?',(delta,delta,item['id']))
      c.execute('INSERT INTO stock_history(item_id,operation,before_total,before_available,after_total,after_available,delta,reason,operator_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',(item['id'],d['direction'],item['total'],item['available'],item['total']+delta,item['available']+delta,delta,reason,uid,t))
    elif path=='/api/inventory/status':
      if not admin: raise ValueError('无管理员权限')
      need(d,'id','status')
      if d['status'] not in ('active','inactive'): raise ValueError('物资状态无效')
      item=c.execute('SELECT * FROM inventory WHERE id=?',(d['id'],)).fetchone()
      if not item: raise ValueError('物资不存在')
      c.execute('UPDATE inventory SET status=? WHERE id=?',(d['status'],item['id']))
      c.execute('INSERT INTO stock_history(item_id,operation,before_total,before_available,after_total,after_available,delta,reason,operator_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',(item['id'],d['status'],item['total'],item['available'],item['total'],item['available'],0,'物资'+('启用' if d['status']=='active' else '停用'),uid,t))
    elif path=='/api/profile':
      need(d,'phone','studentNo','className','department')
      if not re.fullmatch(r'1\d{10}',str(d['phone'])): raise ValueError('联系电话必须为 11 位手机号')
      if not re.fullmatch(r'\d{10}',str(d['studentNo'])): raise ValueError('学号必须为 10 位数字')
      c.execute('UPDATE users SET phone=?,student_no=?,class_name=?,department=? WHERE id=?',(d['phone'],d['studentNo'],d['className'],d['department'],uid))
    elif path=='/api/applications':
      if user['blacklisted']: raise ValueError('你已被列入黑名单，无法提交申请：'+user['blacklist_reason'])
      need(d,'itemId','quantity','borrowDate','returnDate','purpose')
      item=c.execute('SELECT * FROM inventory WHERE id=?',(d['itemId'],)).fetchone(); qty=int(d['quantity'])
      if not item or item['status']!='active' or qty<1 or qty>item['available']: raise ValueError('物资不可借或申请数量超过可用库存')
      c.execute('INSERT INTO applications(user_id,item_id,quantity,borrow_date,return_date,purpose,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',(uid,d['itemId'],qty,d['borrowDate'],d['returnDate'],d['purpose'],t,t))
    elif path=='/api/decision':
      if not admin: raise ValueError('无管理员权限')
      app=c.execute('SELECT * FROM applications WHERE id=?',(d.get('id'),)).fetchone(); decision=d.get('decision')
      if not app or decision not in ('approved','rejected'): raise ValueError('无效审批')
      if app['status'] in ('borrowed','returned','awaiting_borrow_review','awaiting_return_review'): raise ValueError('借还流程已经开始，不能修改审批决定')
      if decision=='rejected' and not str(d.get('reason','')).strip(): raise ValueError('请填写拒绝理由')
      reason=str(d.get('reason','')).strip() if decision=='rejected' else '申请已批准'
      c.execute('UPDATE applications SET status=?,decision_reason=?,decided_by=?,updated_at=? WHERE id=?',(decision,reason,uid,t,app['id']))
      c.execute('INSERT INTO approval_history(application_id,old_status,new_status,reason,operator_id,created_at) VALUES(?,?,?,?,?,?)',(app['id'],app['status'],decision,reason,uid,t))
    elif path=='/api/blacklist':
      if not admin: raise ValueError('无管理员权限')
      need(d,'userId','action'); target=d['userId']; action=d['action']; reason=str(d.get('reason','')).strip()
      if action=='add' and not reason: raise ValueError('请填写拉黑原因')
      if action=='add': c.execute('UPDATE users SET blacklisted=1,blacklist_reason=?,blacklisted_at=?,blacklisted_by=? WHERE id=?',(reason,t,uid,target))
      else: c.execute('UPDATE users SET blacklisted=0,blacklist_reason="",blacklisted_at=NULL,blacklisted_by=NULL WHERE id=?',(target,))
      c.execute('INSERT INTO blacklist_history(user_id,action,reason,operator_id,created_at) VALUES(?,?,?,?,?)',(target,action,reason,uid,t))
    elif path=='/api/appeals':
      need(d,'content');
      if not user['blacklisted']: raise ValueError('当前账号未被拉黑')
      c.execute('INSERT INTO appeals(user_id,content,created_at) VALUES(?,?,?)',(uid,d['content'],t))
    elif path=='/api/appeal-review':
      if not admin: raise ValueError('无管理员权限')
      need(d,'id','status','reply'); c.execute('UPDATE appeals SET status=?,reply=?,handled_at=?,handled_by=? WHERE id=?',(d['status'],d['reply'],t,uid,d['id']))
    elif path=='/api/transactions':
      app=c.execute('SELECT * FROM applications WHERE id=?',(d.get('applicationId'),)).fetchone()
      if not app or (not admin and app['user_id']!=uid): raise ValueError('申请不存在')
      action=d.get('action')
      if action not in ('borrow','return'): raise ValueError('借还操作无效')
      expected='approved' if action=='borrow' else 'borrowed'
      if app['status']!=expected: raise ValueError('申请状态不允许此操作')
      need(d,'photo')
      photo=vision.sanitize_photo(d['photo'])
      analysis=analyze_for_application(c,app,action,photo)
      damage=1 if d.get('damage') else 0
      if damage and (not str(d.get('damageDescription','')).strip() or int(d.get('damageQuantity',0))<1): raise ValueError('报损时必须填写说明和涉及数量')
      recognized=next((x for x in analysis['matchedItems'] if x['itemId']==app['item_id']),None)
      result=c.execute('INSERT INTO transactions(application_id,action,photo,ai_item_id,ai_quantity,damage,damage_type,damage_quantity,damage_description,created_at,vision_result) VALUES(?,?,?,?,?,?,?,?,?,?,?)',(app['id'],action,photo,app['item_id'],recognized['quantity'] if recognized else app['quantity'],damage,d.get('damageType',''),int(d.get('damageQuantity',0)),d.get('damageDescription',''),t,json.dumps(analysis,ensure_ascii=False)))
      auto_posted=False
      if action=='borrow' and not damage and analysis.get('autoEligible') and recognized and recognized['confidence']>=.75:
        changed=c.execute('UPDATE inventory SET available=available-? WHERE id=? AND status="active" AND available>=?',(recognized['quantity'],app['item_id'],recognized['quantity']))
        if changed.rowcount==1:
          c.execute('UPDATE transactions SET final_item_id=?,final_quantity=?,status="confirmed",reviewed_at=?,reviewed_by="system" WHERE id=?',(app['item_id'],recognized['quantity'],t,result.lastrowid))
          auto_posted=True
      c.execute('UPDATE applications SET status=?,updated_at=? WHERE id=?',('borrowed' if auto_posted else 'awaiting_borrow_review' if action=='borrow' else 'awaiting_return_review',t,app['id']))
      return {'ok':True,'autoPosted':auto_posted,'visionStatus':analysis['status']}
    elif path=='/api/vision/analyze':
      app=c.execute('SELECT * FROM applications WHERE id=?',(d.get('applicationId'),)).fetchone()
      if not app or (not admin and app['user_id']!=uid): raise ValueError('申请不存在')
      action='borrow' if app['status']=='approved' else 'return' if app['status']=='borrowed' else None
      if not action: raise ValueError('申请状态不允许拍照核验')
      need(d,'photo')
      check_vision_rate(uid)
      return analyze_for_application(c,app,action,d['photo'])
    elif path=='/api/vision/preview':
      need(d,'photo','itemId','quantity')
      item=c.execute('SELECT * FROM inventory WHERE id=? AND status="active"',(d['itemId'],)).fetchone()
      if not item: raise ValueError('物资不存在或已停用')
      qty=int(d['quantity'])
      if qty<1 or qty>1000: raise ValueError('预期数量须为 1～1000')
      check_vision_rate(uid)
      items=[dict(x) for x in c.execute('SELECT * FROM inventory').fetchall()]
      return vision.analyze(d['photo'],items,item['id'],qty)
    elif path=='/api/review':
      if not admin: raise ValueError('无管理员权限')
      tx=c.execute('SELECT * FROM transactions WHERE id=?',(d.get('id'),)).fetchone()
      if not tx or tx['status']!='pending_review': raise ValueError('记录不存在或已复核')
      item_id=d.get('itemId') or tx['ai_item_id']; qty=int(d.get('quantity') or tx['ai_quantity']); item=c.execute('SELECT * FROM inventory WHERE id=?',(item_id,)).fetchone()
      if not item or qty<1: raise ValueError('请确认有效物资与数量')
      if tx['action']=='borrow':
        if item['status']!='active': raise ValueError('该物资已停用，不能借出')
        if item['available']<qty: raise ValueError('库存不足')
        c.execute('UPDATE inventory SET available=available-? WHERE id=?',(qty,item_id)); newstatus='borrowed'
      else:
        borrowed=c.execute('SELECT final_item_id,final_quantity FROM transactions WHERE application_id=? AND action="borrow" AND status="confirmed" ORDER BY id DESC LIMIT 1',(tx['application_id'],)).fetchone()
        if not borrowed or borrowed['final_item_id']!=item_id or qty>borrowed['final_quantity']: raise ValueError('归还物资或数量与借出记录不符')
        damaged=int(d.get('damageQuantity',tx['damage_quantity'])) if tx['damage'] else 0
        if damaged<0 or damaged>qty: raise ValueError('缺损数量不能超过归还数量')
        good=qty-damaged
        c.execute('UPDATE inventory SET available=MIN(total-damaged-?,available+?),damaged=damaged+? WHERE id=?',(damaged,good,damaged,item_id)); newstatus='returned'
      c.execute('UPDATE transactions SET final_item_id=?,final_quantity=?,damage_quantity=?,status="confirmed",reviewed_at=?,reviewed_by=? WHERE id=?',(item_id,qty,int(d.get('damageQuantity',tx['damage_quantity'])),t,uid,tx['id']))
      c.execute('UPDATE applications SET status=?,updated_at=? WHERE id=(SELECT application_id FROM transactions WHERE id=?)',(newstatus,t,tx['id']))
    elif path=='/api/admin-approval':
      if not admin: raise ValueError('无管理员权限')
      target=c.execute('SELECT * FROM users WHERE id=? AND role="admin"',(d.get('id'),)).fetchone()
      if not target or target['account_status']!='pending': raise ValueError('待审核账号不存在')
      status=d.get('status')
      if status not in ('active','rejected'): raise ValueError('无效审核状态')
      c.execute('UPDATE users SET account_status=? WHERE id=?',(status,target['id']))
    else: raise ValueError('未知操作')
  return {'ok':True}

class Handler(SimpleHTTPRequestHandler):
  def log_message(self,fmt,*args): sys.stdout.write('%s %s\n'%(self.log_date_time_string(),fmt%args));sys.stdout.flush()
  def send_json(self,obj,status=200,cookie=None):
    raw=json.dumps(obj,ensure_ascii=False).encode(); self.send_response(status);self.send_header('Content-Type','application/json; charset=utf-8');self.send_header('Content-Length',len(raw));
    if cookie is not None:self.send_header('Set-Cookie',cookie)
    self.end_headers();self.wfile.write(raw)
  def token(self):
    cookies=self.headers.get('Cookie','')
    for part in cookies.split(';'):
      key,sep,value=part.strip().partition('=')
      if key=='warehouse_session' and sep:return value
    return ''
  def uid(self):
    token=self.token()
    if not token:return None
    session=one('SELECT * FROM sessions WHERE token=? AND expires_at>strftime("%s","now")',(token,))
    return session['user_id'] if session else None
  def body(self):
    n=int(self.headers.get('Content-Length','0'))
    if n>6*1024*1024: raise ValueError('上传内容不能超过 6 MB')
    return json.loads(self.rfile.read(n) or b'{}')
  def require_uid(self):
    uid=self.uid()
    if not uid: raise PermissionError('请先登录')
    return uid
  def auth_post(self,p,d):
    if p=='/api/auth/register':
      need(d,'role','name','studentId','phone','password','confirmPassword')
      role=d['role']; name=str(d['name']).strip(); sid=str(d['studentId']).strip(); phone=str(d['phone']).strip(); password=str(d['password'])
      if role not in ('user','admin'): raise ValueError('注册身份无效')
      if not 2<=len(name)<=20: raise ValueError('姓名应为 2～20 个字符')
      if not re.fullmatch(r'\d{10}',sid): raise ValueError('学号或工号必须为 10 位数字')
      if not re.fullmatch(r'1[3-9]\d{9}',phone): raise ValueError('请输入正确的 11 位手机号')
      if not 6<=len(password)<=20: raise ValueError('密码长度应为 6～20 位')
      if password!=d['confirmPassword']: raise ValueError('两次输入的密码不一致')
      if one('SELECT 1 FROM users WHERE student_no=?',(sid,)): raise ValueError('该学号已注册，请直接登录')
      user_id='usr_'+secrets.token_hex(6); status='pending' if role=='admin' else 'active'
      with conn() as c:c.execute('INSERT INTO users(id,name,role,phone,student_no,class_name,department,password_hash,account_status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',(user_id,name,role,phone,sid,'','',password_hash(password),status,now()))
      return {'ok':True,'status':status,'message':'管理员账号已提交审核' if status=='pending' else '注册成功'}
    if p=='/api/auth/login':
      need(d,'role','studentId','password'); role=d['role']; sid=str(d['studentId']).strip()
      user=one('SELECT * FROM users WHERE student_no=?',(sid,))
      if not user: raise ValueError('账号不存在，请先注册')
      if user['role']!=role: raise ValueError('该账号不是管理员账号' if role=='admin' else '该账号不是师生账号')
      if not password_ok(str(d['password']),user['password_hash']): raise ValueError('密码错误')
      if user['account_status']=='pending': raise ValueError('管理员账号正在等待审核')
      if user['account_status']=='rejected': raise ValueError('管理员注册申请未通过')
      token=secrets.token_urlsafe(32); expires=int(datetime.now().timestamp())+SESSION_SECONDS
      with conn() as c:
        c.execute('DELETE FROM sessions WHERE expires_at<=strftime("%s","now")')
        c.execute('INSERT INTO sessions VALUES(?,?,?,?)',(token,user['id'],now(),expires))
      cookie=f'warehouse_session={token}; Path=/warehouse-ai/; Max-Age={SESSION_SECONDS}; HttpOnly; Secure; SameSite=Lax'
      return {'ok':True,'role':user['role'],'cookie':cookie}
    if p=='/api/auth/logout':
      token=self.token()
      if token:
        with conn() as c:c.execute('DELETE FROM sessions WHERE token=?',(token,))
      return {'ok':True,'cookie':'warehouse_session=; Path=/warehouse-ai/; Max-Age=0; HttpOnly; Secure; SameSite=Lax'}
    if p=='/api/auth/reset-password':
      need(d,'studentId','name','password','confirmPassword'); sid=str(d['studentId']).strip(); name=str(d['name']).strip(); password=str(d['password'])
      if not 6<=len(password)<=20: raise ValueError('密码长度应为 6～20 位')
      if password!=d['confirmPassword']: raise ValueError('两次输入的密码不一致')
      user=one('SELECT * FROM users WHERE student_no=? AND name=?',(sid,name))
      if not user: raise ValueError('学号或姓名不匹配')
      with conn() as c:
        c.execute('UPDATE users SET password_hash=? WHERE id=?',(password_hash(password),user['id']))
        c.execute('DELETE FROM sessions WHERE user_id=?',(user['id'],))
      return {'ok':True,'message':'密码已重置，请重新登录'}
    raise ValueError('未知认证操作')
  def do_GET(self):
    p=urlparse(self.path).path
    if p=='/api/demo/scene':
      try:
        self.require_uid(); raw=(REFERENCES/'demo-scene.jpg').read_bytes()
        self.send_response(200);self.send_header('Content-Type','image/jpeg');self.send_header('Content-Length',len(raw));self.send_header('Cache-Control','private, max-age=86400');self.end_headers();self.wfile.write(raw)
      except PermissionError as e:self.send_json({'error':str(e)},401)
      except Exception:self.send_json({'error':'演示照片不可用'},404)
      return
    if p.startswith('/api/reference/'):
      try:
        self.require_uid(); name=unquote(p.rsplit('/',1)[-1])
        if name not in REFERENCE_NAMES: raise ValueError('样本不存在')
        raw=(REFERENCES/(name+'.jpg')).read_bytes()
        self.send_response(200);self.send_header('Content-Type','image/jpeg');self.send_header('Content-Length',len(raw));self.send_header('Cache-Control','private, max-age=86400');self.end_headers();self.wfile.write(raw)
      except PermissionError as e:self.send_json({'error':str(e)},401)
      except Exception:self.send_json({'error':'样本不可用'},404)
      return
    if p.startswith('/api/batch/photo/'):
      try:
        uid=self.require_uid(); user=one('SELECT role FROM users WHERE id=?',(uid,))
        record=one('''SELECT p.photo,o.user_id FROM batch_captures p JOIN batch_orders o ON o.id=p.order_id WHERE p.id=?''',(p.rsplit('/',1)[-1],))
        if not record or (user['role']!='admin' and record['user_id']!=uid): raise PermissionError('无权查看影像')
        prefix,encoded=record['photo'].split(',',1); raw=base64.b64decode(encoded)
        self.send_response(200);self.send_header('Content-Type','image/jpeg');self.send_header('Content-Length',len(raw));self.send_header('Cache-Control','private, no-store');self.end_headers();self.wfile.write(raw)
      except PermissionError as e:self.send_json({'error':str(e)},403)
      except Exception:self.send_json({'error':'影像不可用'},404)
      return
    if p.startswith('/api/photo/'):
      try:
        uid=self.require_uid(); user=one('SELECT role FROM users WHERE id=?',(uid,))
        record=one('SELECT t.photo,a.user_id FROM transactions t JOIN applications a ON a.id=t.application_id WHERE t.id=?',(p.rsplit('/',1)[-1],))
        if not record or not record['photo'] or (user['role']!='admin' and record['user_id']!=uid): raise PermissionError('无权查看影像')
        prefix,encoded=record['photo'].split(',',1); raw=base64.b64decode(encoded)
        self.send_response(200);self.send_header('Content-Type',prefix[5:].split(';',1)[0]);self.send_header('Content-Length',len(raw));self.send_header('Cache-Control','private, no-store');self.end_headers();self.wfile.write(raw)
      except PermissionError as e:self.send_json({'error':str(e)},403)
      except Exception as e:self.send_json({'error':'影像不可用'},404)
      return
    if p=='/api/auth/me':
      uid=self.uid(); user=one('SELECT id,name,role,phone,student_no,account_status FROM users WHERE id=?',(uid,)) if uid else None
      self.send_json({'authenticated':bool(user),'user':user});return
    if p=='/api/state':
      try:self.send_json(state(self.require_uid()))
      except PermissionError as e:self.send_json({'error':str(e)},401)
      except Exception as e:self.send_json({'error':str(e)},400)
      return
    if p=='/health': self.send_json({'ok':True});return
    self.path='/index.html' if p=='/' else p; return SimpleHTTPRequestHandler.do_GET(self)
  def do_POST(self):
    try:
      p=urlparse(self.path).path;d=self.body()
      if p.startswith('/api/auth/'):
        result=self.auth_post(p,d);cookie=result.pop('cookie',None);self.send_json(result,cookie=cookie);return
      self.send_json(mutate(p,d,self.require_uid()))
    except PermissionError as e:self.send_json({'error':str(e)},401)
    except (ValueError,sqlite3.Error) as e:self.send_json({'error':str(e)},400)
    except Exception as e:self.send_json({'error':'服务器错误'},500);raise
  def translate_path(self,path):
    p=urlparse(path).path.lstrip('/')
    target=(STATIC/p).resolve()
    if not target.is_relative_to(STATIC.resolve()): return str(STATIC/'not-found')
    return str(target)

if __name__=='__main__': init(); print(f'warehouse-ai listening on {HOST}:{PORT} db={DB}'); ThreadingHTTPServer((HOST,PORT),Handler).serve_forever()
