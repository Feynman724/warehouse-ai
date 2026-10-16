"""One-photo, multi-item borrowing with atomic inventory changes."""
import json
import secrets
import sqlite3

import vision


def init(c):
    c.executescript('''
    CREATE TABLE IF NOT EXISTS batch_orders(
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, borrow_date TEXT NOT NULL,
      return_date TEXT NOT NULL, purpose TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      decision_reason TEXT DEFAULT '', decided_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS batch_lines(
      order_id INTEGER NOT NULL, item_id TEXT NOT NULL, quantity INTEGER NOT NULL CHECK(quantity>0),
      PRIMARY KEY(order_id,item_id), FOREIGN KEY(order_id) REFERENCES batch_orders(id),
      FOREIGN KEY(item_id) REFERENCES inventory(id));
    CREATE TABLE IF NOT EXISTS batch_order_history(
      id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL,
      old_status TEXT NOT NULL, new_status TEXT NOT NULL, reason TEXT NOT NULL,
      operator_id TEXT NOT NULL, created_at TEXT NOT NULL,
      FOREIGN KEY(order_id) REFERENCES batch_orders(id));
    CREATE TABLE IF NOT EXISTS batch_captures(
      id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL, action TEXT NOT NULL,
      photo TEXT NOT NULL, analysis TEXT NOT NULL, status TEXT NOT NULL,
      created_at TEXT NOT NULL, reviewed_at TEXT, reviewed_by TEXT,
      UNIQUE(order_id,action), FOREIGN KEY(order_id) REFERENCES batch_orders(id));
    CREATE TABLE IF NOT EXISTS batch_capture_lines(
      capture_id INTEGER NOT NULL, item_id TEXT NOT NULL, suggested_quantity INTEGER,
      final_quantity INTEGER, damaged_quantity INTEGER DEFAULT 0,
      PRIMARY KEY(capture_id,item_id), FOREIGN KEY(capture_id) REFERENCES batch_captures(id),
      FOREIGN KEY(item_id) REFERENCES inventory(id));
    ''')


def order_lines(c, order_id):
    return [dict(row) for row in c.execute('''SELECT l.item_id itemId,i.name,l.quantity,i.unit
      FROM batch_lines l JOIN inventory i ON i.id=l.item_id WHERE l.order_id=? ORDER BY i.name''', (order_id,))]


def state(c, uid, admin):
    orders = [dict(row) for row in c.execute('''SELECT o.*,u.name applicant,u.phone
      FROM batch_orders o JOIN users u ON u.id=o.user_id
      WHERE (? OR o.user_id=?) ORDER BY o.id DESC''', (admin, uid))]
    captures = [dict(row) for row in c.execute('''SELECT p.id,p.order_id,p.action,p.status,p.created_at,p.reviewed_at,p.reviewed_by,
      p.analysis,o.user_id,u.name applicant FROM batch_captures p JOIN batch_orders o ON o.id=p.order_id
      JOIN users u ON u.id=o.user_id WHERE (? OR o.user_id=?) ORDER BY p.id DESC''', (admin, uid))]
    for order in orders:
        order['items'] = order_lines(c, order['id'])
        order['decisionHistory'] = [dict(row) for row in c.execute('''SELECT old_status oldStatus,
          new_status newStatus,reason,created_at createdAt FROM batch_order_history
          WHERE order_id=? ORDER BY id DESC''', (order['id'],))]
    for capture in captures:
        capture['analysis'] = json.loads(capture['analysis'])
        capture['items'] = [dict(row) for row in c.execute('''SELECT l.item_id itemId,i.name,l.suggested_quantity suggestedQuantity,
          l.final_quantity finalQuantity,l.damaged_quantity damagedQuantity
          FROM batch_capture_lines l JOIN inventory i ON i.id=l.item_id WHERE l.capture_id=? ORDER BY i.name''', (capture['id'],))]
    return {'batchOrders': orders, 'batchCaptures': captures}


def owned_order(c, order_id, uid, admin):
    order = c.execute('SELECT * FROM batch_orders WHERE id=?', (order_id,)).fetchone()
    if not order or (not admin and order['user_id'] != uid):
        raise ValueError('批量申请不存在')
    return order


def analysis_for(c, order, photo, action):
    expected = order_lines(c, order['id'])
    before = None
    if action == 'return':
        borrowed = c.execute('''SELECT p.photo FROM batch_captures p
          WHERE p.order_id=? AND p.action='borrow' AND p.status='confirmed' ''', (order['id'],)).fetchone()
        if borrowed:
            before = borrowed['photo']
        actual = [dict(row) for row in c.execute('''SELECT l.item_id itemId,l.final_quantity quantity
          FROM batch_capture_lines l JOIN batch_captures p ON p.id=l.capture_id
          WHERE p.order_id=? AND p.action='borrow' AND l.final_quantity>0''', (order['id'],))]
        expected = actual
    inventory = [dict(row) for row in c.execute('SELECT * FROM inventory')]
    return vision.analyze_batch(photo, inventory, expected, before)


def mutate(c, path, data, user, timestamp):
    uid = user['id']
    admin = user['role'] == 'admin'
    if path == '/api/batch/create':
        if user['blacklisted']:
            raise ValueError('当前账号无法提交申请')
        requested = data.get('items')
        if not isinstance(requested, list) or not 1 <= len(requested) <= 30:
            raise ValueError('请选择 1～30 类物资')
        purpose = str(data.get('purpose', '')).strip()
        borrow_date = str(data.get('borrowDate', ''))
        return_date = str(data.get('returnDate', ''))
        if not purpose or len(purpose) > 500 or not borrow_date or not return_date or return_date < borrow_date:
            raise ValueError('请填写有效借还日期和用途')
        validated = []
        seen = set()
        for entry in requested:
            item_id = str(entry.get('itemId', ''))
            if item_id in seen:
                raise ValueError('物资不能重复添加')
            seen.add(item_id)
            item = c.execute('SELECT * FROM inventory WHERE id=? AND status="active"', (item_id,)).fetchone()
            try: quantity = int(entry.get('quantity', 0))
            except (ValueError, TypeError): raise ValueError('物资数量无效')
            if not item or quantity < 1 or quantity > item['available']:
                raise ValueError('物资不可借或数量超过可用库存')
            validated.append((item_id, quantity))
        result = c.execute('''INSERT INTO batch_orders(user_id,borrow_date,return_date,purpose,created_at,updated_at)
          VALUES(?,?,?,?,?,?)''', (uid, borrow_date, return_date, purpose, timestamp, timestamp))
        c.executemany('INSERT INTO batch_lines(order_id,item_id,quantity) VALUES(?,?,?)',
                      [(result.lastrowid, item_id, quantity) for item_id, quantity in validated])
        return {'ok': True, 'id': result.lastrowid}
    if path == '/api/batch/decision':
        if not admin:
            raise ValueError('无管理员权限')
        order = owned_order(c, data.get('id'), uid, admin)
        if order['status'] not in ('pending', 'approved', 'rejected'):
            raise ValueError('借还流程已经开始')
        decision = data.get('decision')
        reason = str(data.get('reason', '')).strip()
        if decision not in ('approved', 'rejected') or (decision == 'rejected' and not reason):
            raise ValueError('请选择决定并填写拒绝理由')
        c.execute('''UPDATE batch_orders SET status=?,decision_reason=?,decided_by=?,updated_at=? WHERE id=?''',
                  (decision, reason if decision == 'rejected' else '申请已批准', uid, timestamp, order['id']))
        c.execute('''INSERT INTO batch_order_history(order_id,old_status,new_status,reason,operator_id,created_at)
          VALUES(?,?,?,?,?,?)''', (order['id'], order['status'], decision,
              reason if decision == 'rejected' else '申请已批准', uid, timestamp))
        return {'ok': True}
    if path in ('/api/batch/analyze', '/api/batch/capture'):
        order = owned_order(c, data.get('orderId'), uid, admin)
        action = 'borrow' if order['status'] == 'approved' else 'return' if order['status'] == 'borrowed' else None
        if action is None:
            raise ValueError('当前状态不能拍照')
        photo = data.get('photo')
        if not photo:
            raise ValueError('请上传现场照片')
        if path == '/api/batch/analyze':
            return analysis_for(c, order, photo, action)
        photo = vision.sanitize_photo(photo)
        report = analysis_for(c, order, photo, action)
        result = c.execute('''INSERT INTO batch_captures(order_id,action,photo,analysis,status,created_at)
          VALUES(?,?,?,?,?,?)''', (order['id'], action, photo, json.dumps(report, ensure_ascii=False), 'pending_review', timestamp))
        capture_id = result.lastrowid
        recognized = {item['itemId']: item for item in report['matchedItems']}
        expected = report['expectedItems']
        for entry in expected:
            suggestion = recognized.get(entry['itemId'], {}).get('quantity')
            c.execute('''INSERT INTO batch_capture_lines(capture_id,item_id,suggested_quantity)
              VALUES(?,?,?)''', (capture_id, entry['itemId'], suggestion))
        auto = action == 'borrow' and report['autoEligible']
        if auto:
            for entry in expected:
                item = c.execute('SELECT total,available FROM inventory WHERE id=?', (entry['itemId'],)).fetchone()
                updated = c.execute('''UPDATE inventory SET available=available-? WHERE id=?
                  AND status='active' AND available>=?''',
                    (entry['quantity'], entry['itemId'], entry['quantity']))
                if updated.rowcount != 1:
                    raise ValueError('库存不足，请联系管理员')
                c.execute('''UPDATE batch_capture_lines SET final_quantity=? WHERE capture_id=? AND item_id=?''',
                          (entry['quantity'], capture_id, entry['itemId']))
                c.execute('''INSERT INTO stock_history(item_id,operation,before_total,before_available,after_total,
                  after_available,delta,reason,operator_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)''',
                  (entry['itemId'], 'batch_borrow', item['total'], item['available'], item['total'],
                   item['available']-entry['quantity'], -entry['quantity'],
                   '同框照片 #' + str(capture_id) + ' 视觉核验通过', 'system', timestamp))
            c.execute('''UPDATE batch_captures SET status='confirmed',reviewed_at=?,reviewed_by='system' WHERE id=?''',
                      (timestamp, capture_id))
        new_status = 'borrowed' if auto else 'awaiting_borrow_review' if action == 'borrow' else 'awaiting_return_review'
        c.execute('UPDATE batch_orders SET status=?,updated_at=? WHERE id=?', (new_status, timestamp, order['id']))
        return {'ok': True, 'id': capture_id, 'autoPosted': auto, 'visionStatus': report['status']}
    if path == '/api/batch/review':
        if not admin:
            raise ValueError('无管理员权限')
        capture = c.execute('SELECT * FROM batch_captures WHERE id=? AND status="pending_review"',
                            (data.get('id'),)).fetchone()
        if not capture:
            raise ValueError('待复核照片不存在')
        supplied = data.get('items')
        expected = [dict(row) for row in c.execute('SELECT item_id FROM batch_capture_lines WHERE capture_id=?', (capture['id'],))]
        if not isinstance(supplied, list) or {x.get('itemId') for x in supplied} != {x['item_id'] for x in expected} or len(supplied) != len(expected):
            raise ValueError('请核对照片中的全部物资')
        borrowed = {}
        if capture['action'] == 'return':
            borrowed = {row['item_id']: row['final_quantity'] for row in c.execute('''SELECT l.item_id,l.final_quantity
              FROM batch_capture_lines l JOIN batch_captures p ON p.id=l.capture_id
              WHERE p.order_id=? AND p.action='borrow' AND p.status='confirmed' ''', (capture['order_id'],))}
        changed = []
        for entry in supplied:
            item = c.execute('SELECT * FROM inventory WHERE id=?', (entry['itemId'],)).fetchone()
            try:
                quantity = int(entry.get('quantity', -1))
                damaged = int(entry.get('damaged', 0))
            except (ValueError, TypeError): raise ValueError('数量格式无效')
            if not item or quantity < 0 or damaged < 0:
                raise ValueError('请填写有效数量')
            if capture['action'] == 'borrow':
                if damaged or item['status'] != 'active' or quantity > item['available']:
                    raise ValueError('借出数量超过可用库存')
                c.execute('UPDATE inventory SET available=available-? WHERE id=?', (quantity, item['id']))
                delta = -quantity
            else:
                if quantity + damaged != borrowed.get(item['id'], 0):
                    raise ValueError('每类物资的完好归还数与缺损数之和必须等于实际借出数')
                c.execute('UPDATE inventory SET available=available+?,damaged=damaged+? WHERE id=?',
                          (quantity, damaged, item['id']))
                delta = quantity
            c.execute('UPDATE batch_capture_lines SET final_quantity=?,damaged_quantity=? WHERE capture_id=? AND item_id=?',
                      (quantity, damaged, capture['id'], item['id']))
            c.execute('''INSERT INTO stock_history(item_id,operation,before_total,before_available,after_total,
              after_available,delta,reason,operator_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)''',
              (item['id'], 'batch_' + capture['action'], item['total'], item['available'], item['total'],
               item['available'] + delta, delta, '同框照片 #' + str(capture['id']) + ' 管理员复核', uid, timestamp))
            changed.append(quantity)
        if capture['action'] == 'borrow' and not any(changed):
            raise ValueError('至少确认一件借出物资')
        c.execute('UPDATE batch_captures SET status="confirmed",reviewed_at=?,reviewed_by=? WHERE id=?',
                  (timestamp, uid, capture['id']))
        c.execute('UPDATE batch_orders SET status=?,updated_at=? WHERE id=?',
                  ('borrowed' if capture['action'] == 'borrow' else 'returned', timestamp, capture['order_id']))
        return {'ok': True}
    raise ValueError('未知批量操作')
