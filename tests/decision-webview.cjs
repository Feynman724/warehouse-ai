const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const code = fs.readFileSync(path.join(__dirname, '../static/app.js'), 'utf8');
const dom = new JSDOM('<div id="nav"></div><div id="mobile"></div><div id="crumb"></div><div id="root"></div><div id="modal-root"></div><div id="toast-root"></div><button id="contact"></button>', { url: 'https://test.local/warehouse-ai/', runScripts: 'outside-only' });
const win = dom.window;
const state = {
  config: { adminPhone: '10086' }, currentUser: { id: 'admin', name: '管理员', role: 'admin' },
  inventory: [], applications: [{ id: 1, item_name: '折叠椅', quantity: 1, applicant: '测试', department: '测试', phone: '', student_no: '', class_name: '', borrow_date: '2026-10-15', return_date: '2026-10-16', purpose: '测试', status: 'pending', created_at: '2026-10-15' }],
  transactions: [], history: [], blacklistHistory: [], users: [], pendingAdmins: [], appeals: [], stockHistory: [],
};
const calls = [];
win.fetch = async (url, options = {}) => {
  calls.push({ url, options });
  return { ok: true, status: 200, json: async () => url.includes('/api/state') ? state : { ok: true } };
};
// WebView/native submission may be swallowed before document-level submit delegation.
win.document.addEventListener('click', event => {
  if (event.target.matches('#decision-form .modal-footer button')) event.preventDefault();
}, true);
win.eval(code);

const tick = () => new Promise(resolve => setTimeout(resolve, 10));
(async () => {
  await tick();
  win.document.querySelector('[data-view="applications"]').click();
  win.document.querySelector('[data-action="decision"][data-decision="rejected"]').click();
  const button = win.document.querySelector('#decision-form .modal-footer button');
  button.click();
  assert.match(win.document.querySelector('#decision-error').textContent, /请填写拒绝理由/);
  assert.equal(calls.filter(x => x.url.endsWith('/api/decision')).length, 0);
  win.document.querySelector('textarea[name="reason"]').value = '不予批准';
  button.click();
  await tick();
  assert.equal(calls.filter(x => x.url.endsWith('/api/decision')).length, 1);
  assert.equal(JSON.parse(calls.find(x => x.url.endsWith('/api/decision')).options.body).reason, '不予批准');
  console.log('Decision tap shows validation and submits once even when native form submission is suppressed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
