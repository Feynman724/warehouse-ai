(() => {
  "use strict";

  const STORAGE_KEY = "warehouse-ai-mvp-v2";
  const now = new Date();
  const isoDate = (offset = 0) => {
    const date = new Date(now);
    date.setDate(date.getDate() + offset);
    return date.toISOString().slice(0, 10);
  };

  const seedState = () => ({
    version: 2,
    role: "admin",
    currentView: "inventory",
    currentUser: { name: "林同学", department: "宣传部", phone: "13800138000", studentId: "3230100001", className: "计科 2301" },
    currentAdmin: { name: "物资管理员" },
    settings: { adminPhone: "13800138000" },
    inventory: [
      { id: "table", code: "TB", name: "折叠桌", category: "桌椅类", total: 12, available: 10, damaged: 0, location: "A 区 · 货架 01" },
      { id: "chair", code: "CH", name: "折叠椅", category: "桌椅类", total: 40, available: 34, damaged: 0, location: "A 区 · 货架 02" },
      { id: "tent", code: "TN", name: "四角帐篷", category: "搭建类", total: 8, available: 6, damaged: 0, location: "B 区 · 地面位 03" }
    ],
    applications: [
      {
        id: "REQ-260930-01",
        applicant: "陈同学",
        department: "文艺部",
        phone: "13900139000",
        studentId: "3230100002",
        className: "设计 2301",
        inventoryId: "chair",
        quantity: 6,
        borrowDate: isoDate(2),
        returnDate: isoDate(4),
        purpose: "迎新晚会观众席布置",
        status: "pending",
        note: "",
        decisionHistory: [],
        createdAt: new Date(now.getTime() - 40 * 60 * 1000).toISOString()
      },
      {
        id: "REQ-260930-02",
        applicant: "林同学",
        department: "宣传部",
        phone: "13800138000",
        studentId: "3230100001",
        className: "计科 2301",
        inventoryId: "table",
        quantity: 2,
        borrowDate: isoDate(1),
        returnDate: isoDate(2),
        purpose: "校园宣传活动物料摆放",
        status: "approved",
        note: "请在 16:00 前领取",
        decisionHistory: [{ from: "pending", to: "approved", at: new Date(now.getTime() - 25 * 60 * 1000).toISOString(), operator: "物资管理员", reason: "" }],
        createdAt: new Date(now.getTime() - 95 * 60 * 1000).toISOString(),
        approvedAt: new Date(now.getTime() - 25 * 60 * 1000).toISOString()
      }
    ],
    transactions: [],
    records: [],
    blacklist: []
  });

  let state = loadState();
  let captureDraft = { applicationId: "", action: "borrow", photoData: "", results: [], scanning: false, damage: null };
  let inventoryFilter = "all";
  let searchText = "";

  const viewRoot = document.getElementById("view-root");
  const modalRoot = document.getElementById("modal-root");
  const toastRoot = document.getElementById("toast-root");

  const navConfig = {
    user: [
      ["inventory", "01", "库存"],
      ["apply", "02", "申请"],
      ["applications", "03", "我的申请"],
      ["capture", "04", "拍照借还"]
    ],
    admin: [
      ["inventory", "01", "库存"],
      ["applications", "02", "申请审批"],
      ["capture", "03", "拍照借还"],
      ["review", "04", "识别复核"],
      ["records", "05", "借还记录"],
      ["blacklist", "06", "黑名单"],
      ["damage", "07", "报损记录"]
    ]
  };

  const viewTitles = {
    inventory: "库存总览",
    apply: "借用申请",
    applications: "申请管理",
    capture: "拍照借还",
    review: "识别复核",
    records: "借还记录",
    blacklist: "黑名单管理",
    damage: "报损记录"
  };

  const statusLabels = {
    pending: ["待审批", "warning"],
    approved: ["已批准", "info"],
    rejected: ["已拒绝", "danger"],
    awaiting_borrow_review: ["借出待复核", "warning"],
    borrowed: ["借出中", "info"],
    awaiting_return_review: ["归还待复核", "warning"],
    returned: ["已归还", "success"]
  };

  function loadState() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (saved && saved.version === 2) return saved;
    } catch (error) {
      console.warn("无法读取本地演示数据，已恢复默认状态。", error);
    }
    return seedState();
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (error) {
      showToast("照片较大，浏览器本地空间不足；请换一张较小的照片。", "error");
      console.error(error);
    }
  }

  function esc(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function formatDate(value, withTime = false) {
    if (!value) return "—";
    const date = new Date(value.length === 10 ? `${value}T00:00:00` : value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {})
    }).format(date);
  }

  function inventoryById(id) {
    return state.inventory.find(item => item.id === id);
  }

  function applicationById(id) {
    return state.applications.find(item => item.id === id);
  }

  function activeBlacklistForUser(user = state.currentUser) {
    return state.blacklist.find(entry => entry.active && (entry.studentId === user.studentId || entry.userName === user.name));
  }

  function badge(status) {
    const [label, tone] = statusLabels[status] || [status, "neutral"];
    return `<span class="badge badge-${tone}">${esc(label)}</span>`;
  }

  function inventoryStatus(item) {
    if (item.available <= 0) return ["无库存", "danger"];
    if (item.available / item.total <= .25) return ["库存偏低", "warning"];
    return ["可借", "success"];
  }

  function showToast(message, type = "success") {
    const node = document.createElement("div");
    node.className = `toast ${type === "error" ? "error" : ""}`;
    node.textContent = message;
    toastRoot.appendChild(node);
    setTimeout(() => node.remove(), 3200);
  }

  function navigate(view) {
    const allowed = navConfig[state.role].map(item => item[0]);
    if (!allowed.includes(view)) view = "inventory";
    state.currentView = view;
    saveState();
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function render() {
    const allowed = navConfig[state.role].map(item => item[0]);
    if (!allowed.includes(state.currentView)) state.currentView = "inventory";
    renderShell();
    const renderers = {
      inventory: renderInventory,
      apply: renderApply,
      applications: renderApplications,
      capture: renderCapture,
      review: renderReview,
      records: renderRecords,
      blacklist: renderBlacklist,
      damage: renderDamageRecords
    };
    viewRoot.innerHTML = renderers[state.currentView]();
    viewRoot.classList.remove("view-root");
    void viewRoot.offsetWidth;
    viewRoot.classList.add("view-root");
  }

  function renderShell() {
    const items = navConfig[state.role];
    document.getElementById("desktop-nav").innerHTML = items.map(([view, glyph, label]) => `
      <button class="nav-button ${state.currentView === view ? "active" : ""}" data-action="navigate" data-view="${view}">
        <span class="nav-glyph">${glyph}</span><span>${label}</span>
      </button>`).join("");
    document.getElementById("mobile-nav").innerHTML = items.slice(0, 4).map(([view, glyph, label]) => `
      <button class="${state.currentView === view ? "active" : ""}" data-action="navigate" data-view="${view}">
        <span class="nav-glyph">${glyph}</span>${label}
      </button>`).join("");

    document.querySelectorAll("[data-action='set-role']").forEach(button => {
      button.classList.toggle("active", button.dataset.role === state.role);
    });
    document.getElementById("breadcrumb").textContent = `仓库 A · ${viewTitles[state.currentView]}`;
    document.getElementById("avatar").textContent = state.role === "admin" ? "管" : state.currentUser.name.slice(0, 1);
    document.getElementById("profile-name").textContent = state.role === "admin" ? "物资管理员" : state.currentUser.name;
  }

  function pageHead(eyebrow, title, description, actions = "") {
    return `<section class="page-head">
      <div class="page-head-copy"><p class="eyebrow">${esc(eyebrow)}</p><h1>${title}</h1><p>${esc(description)}</p></div>
      ${actions ? `<div class="head-actions">${actions}</div>` : ""}
    </section>`;
  }

  function renderInventory() {
    const availableCount = state.inventory.reduce((sum, item) => sum + item.available, 0);
    const pendingApps = state.applications.filter(item => item.status === "pending").length;
    const pendingReviews = state.transactions.filter(item => item.status === "pending_review").length;
    const actions = state.role === "admin"
      ? `<button class="button button-secondary" data-action="navigate" data-view="blacklist">黑名单</button><button class="button button-secondary" data-action="navigate" data-view="damage">报损记录</button><button class="button button-secondary" data-action="navigate" data-view="review">查看待复核</button><button class="button button-primary" data-action="navigate" data-view="capture">开始拍照借还</button>`
      : `<button class="button button-secondary" data-action="navigate" data-view="applications">查看我的申请</button><button class="button button-primary" data-action="navigate" data-view="apply">提交借用申请</button>`;

    const rows = state.inventory
      .filter(item => inventoryFilter === "all" || item.category === inventoryFilter)
      .filter(item => `${item.name}${item.category}${item.location}`.toLowerCase().includes(searchText.toLowerCase()))
      .map(item => {
        const [label, tone] = inventoryStatus(item);
        return `<div class="inventory-row">
          <div class="item-cell"><div class="item-thumb">${esc(item.code)}</div><div><strong>${esc(item.name)}</strong><small>${esc(item.category)}${item.damaged ? ` · 缺损待处理 ${item.damaged}` : ""}</small></div></div>
          <div class="quantity-cell"><strong>${item.available}</strong><small> / ${item.total} 件</small></div>
          <div class="status-cell"><span class="badge badge-${tone}">${label}</span></div>
          <div class="location-cell">${esc(item.location)}</div>
          ${state.role === "admin"
            ? `<button class="action-link" data-action="edit-inventory" data-id="${item.id}">编辑</button>`
            : `<button class="action-link" data-action="quick-apply" data-id="${item.id}" ${item.available < 1 ? "disabled" : ""}>申请</button>`}
        </div>`;
      }).join("");

    return `${pageHead("Inventory overview", "今天的物资，<br>一眼看清。", "高频物资的库存、申请和复核状态集中在同一工作台。", actions)}
      <section class="stats" aria-label="仓库统计">
        <div class="stat"><div class="stat-label">高频物资类别</div><div class="stat-value">${state.inventory.length}<span>类</span></div></div>
        <div class="stat"><div class="stat-label">当前可借</div><div class="stat-value">${availableCount}<span>件</span></div></div>
        <div class="stat"><div class="stat-label">待审批申请</div><div class="stat-value">${pendingApps}<span>项</span></div></div>
        <div class="stat"><div class="stat-label">待人工复核</div><div class="stat-value">${pendingReviews}<span>项</span></div></div>
      </section>
      <div class="toolbar">
        <label class="search-wrap"><input id="inventory-search" type="search" placeholder="搜索物资或位置" value="${esc(searchText)}" aria-label="搜索物资"></label>
        <div class="filter-chips">
          ${["all", ...new Set(state.inventory.map(item => item.category))].map(category => `<button class="chip ${inventoryFilter === category ? "active" : ""}" data-action="filter-inventory" data-filter="${esc(category)}">${category === "all" ? "全部" : esc(category)}</button>`).join("")}
        </div>
      </div>
      <section class="card"><header class="card-head"><div><h2>高频物资库存</h2><p>第一版覆盖三类物资；当前为演示数据</p></div><span class="badge badge-neutral">${rows ? "实时本地数据" : "无结果"}</span></header>
        <div class="inventory-list">${rows || emptyState("00", "没有匹配的物资", "尝试修改搜索词或筛选条件。", "")}</div>
      </section>`;
  }

  function renderApply() {
    if (state.role !== "user") return deniedState();
    const blocked = activeBlacklistForUser();
    if (blocked) {
      const appeal = blocked.appeal;
      return `${pageHead("Borrow request", "暂时无法提交申请", "该账号已被管理员列入黑名单。")}
        <section class="card"><div class="card-body"><div class="notice notice-danger"><strong>拉黑原因：</strong>${esc(blocked.reason)}</div><div class="spacer-20"></div>
        <div class="summary-list"><div class="summary-item"><span>处理时间</span><strong>${formatDate(blocked.createdAt, true)}</strong></div><div class="summary-item"><span>管理员电话</span><strong>${esc(state.settings.adminPhone || "暂未配置")}</strong></div><div class="summary-item"><span>申诉状态</span><strong>${appeal ? ({pending:"待管理员处理",approved:"申诉通过",rejected:"申诉未通过"}[appeal.status] || appeal.status) : "尚未申诉"}</strong></div></div>
        <div class="form-footer">${!appeal || appeal.status === "rejected" ? `<button class="button button-primary" data-action="appeal-blacklist" data-id="${blocked.id}">提交申诉</button>` : ""}</div></div></section>`;
    }
    const selected = sessionStorage.getItem("quickApplyItem") || state.inventory[0].id;
    sessionStorage.removeItem("quickApplyItem");
    const inventory = inventoryById(selected) || state.inventory[0];
    return `${pageHead("Borrow request", "提交借用申请", "填写物资、时间和用途。管理员审批后才能领取。")}
      <section class="two-column">
        <form id="application-form" class="card">
          <header class="card-head"><div><h2>申请信息</h2><p>带 * 的项目为必填</p></div><span class="badge badge-info">普通用户</span></header>
          <div class="card-body">
            <div class="form-grid">
              <div class="field"><label for="applicant">申请人</label><input id="applicant" value="${esc(state.currentUser.name)}" readonly></div>
              <div class="field"><label for="department">所属部门 *</label><input id="department" name="department" value="${esc(state.currentUser.department)}" required></div>
              <div class="field"><label for="phone">联系电话 *</label><input id="phone" name="phone" inputmode="numeric" pattern="1[3-9][0-9]{9}" maxlength="11" value="${esc(state.currentUser.phone || "")}" placeholder="11 位手机号" required><span class="field-note">请输入 11 位中国大陆手机号</span></div>
              <div class="field"><label for="student-id">学号 *</label><input id="student-id" name="studentId" inputmode="numeric" pattern="[0-9]{10}" maxlength="10" value="${esc(state.currentUser.studentId || "")}" placeholder="10 位数字" required><span class="field-note">学号将与当前演示账号绑定</span></div>
              <div class="field field-full"><label for="class-name">行政班级 *</label><input id="class-name" name="className" value="${esc(state.currentUser.className || "")}" placeholder="例如：计科 2301" required></div>
              <div class="field"><label for="inventory-id">物资 *</label><select id="inventory-id" name="inventoryId" required>${state.inventory.map(item => `<option value="${item.id}" ${item.id === inventory.id ? "selected" : ""}>${esc(item.name)}（可借 ${item.available}）</option>`).join("")}</select></div>
              <div class="field"><label for="quantity">数量 *</label><input id="quantity" name="quantity" type="number" min="1" max="${inventory.available}" value="1" required><span id="availability-note" class="field-note">当前可借 ${inventory.available} 件</span></div>
              <div class="field"><label for="borrow-date">借用日期 *</label><input id="borrow-date" name="borrowDate" type="date" min="${isoDate(0)}" value="${isoDate(1)}" required></div>
              <div class="field"><label for="return-date">预计归还 *</label><input id="return-date" name="returnDate" type="date" min="${isoDate(0)}" value="${isoDate(2)}" required></div>
              <div class="field field-full"><label for="purpose">用途说明 *</label><textarea id="purpose" name="purpose" placeholder="例如：迎新活动现场布置" required></textarea></div>
            </div>
            <div class="form-footer"><button type="button" class="button button-secondary" data-action="navigate" data-view="inventory">取消</button><button type="submit" class="button button-primary">提交申请</button></div>
          </div>
        </form>
        <aside class="card">
          <header class="card-head"><div><h2>申请须知</h2><p>第一版流程规则</p></div></header>
          <div class="card-body">
            <div class="notice">提交后由管理员审批。库存只在借出照片复核通过后扣减。</div>
            <div class="spacer-20"></div>
            <div class="summary-list">
              <div class="summary-item"><span>当前物资</span><strong id="summary-item">${esc(inventory.name)}</strong></div>
              <div class="summary-item"><span>存放位置</span><strong id="summary-location">${esc(inventory.location)}</strong></div>
              <div class="summary-item"><span>审批状态</span><strong>提交后待审批</strong></div>
            </div>
          </div>
        </aside>
      </section>`;
  }

  function renderApplications() {
    const items = state.role === "admin"
      ? [...state.applications]
      : state.applications.filter(item => item.applicant === state.currentUser.name);
    items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const actions = state.role === "user" ? `<button class="button button-primary" data-action="navigate" data-view="apply">新建申请</button>` : "";
    const description = state.role === "admin" ? "审批待处理申请，已批准申请进入拍照借还流程。" : "查看审批进度，并从已批准申请开始领取或归还。";
    return `${pageHead("Applications", state.role === "admin" ? "申请审批" : "我的申请", description, actions)}
      <section class="application-list">
        ${items.length ? items.map(applicationCard).join("") : `<div class="card">${emptyState("00", "暂无申请", state.role === "user" ? "先从库存页选择物资并提交申请。" : "新的借用申请会出现在这里。", state.role === "user" ? `<button class="button button-primary" data-action="navigate" data-view="apply">提交申请</button>` : "")}</div>`}
      </section>`;
  }

  function applicationCard(app) {
    const item = inventoryById(app.inventoryId);
    let actionButtons = "";
    if (state.role === "admin" && app.status === "pending") {
      actionButtons = `<button class="button button-small button-secondary" data-action="blacklist-applicant" data-id="${app.id}">加入黑名单</button><button class="button button-small button-danger" data-action="reject-application" data-id="${app.id}">拒绝</button><button class="button button-small button-primary" data-action="approve-application" data-id="${app.id}">批准</button>`;
    } else if (state.role === "admin" && ["approved", "rejected"].includes(app.status)) {
      actionButtons = `<button class="button button-small button-secondary" data-action="blacklist-applicant" data-id="${app.id}">加入黑名单</button><button class="button button-small button-primary" data-action="modify-decision" data-id="${app.id}">修改决定</button>`;
    } else if (app.status === "approved") {
      actionButtons = `<button class="button button-small button-primary" data-action="start-capture" data-id="${app.id}" data-mode="borrow">拍照借出</button>`;
    } else if (app.status === "borrowed") {
      actionButtons = `<button class="button button-small button-primary" data-action="start-capture" data-id="${app.id}" data-mode="return">拍照归还</button>`;
    } else if (state.role === "admin" && ["awaiting_borrow_review", "awaiting_return_review"].includes(app.status)) {
      actionButtons = `<button class="button button-small button-primary" data-action="navigate" data-view="review">前往复核</button>`;
    }
    if ((app.decisionHistory || []).length) actionButtons = `<button class="button button-small button-secondary" data-action="decision-history" data-id="${app.id}">审批历史</button>${actionButtons}`;

    return `<article class="application-card">
      <div class="application-top"><div><h3>${esc(app.id)}</h3><div class="application-meta">${esc(app.applicant)} · ${esc(app.department)} · ${formatDate(app.createdAt, true)}</div></div>${badge(app.status)}</div>
      <div class="application-items"><span class="item-pill">${esc(item?.name || "未知物资")} × ${app.quantity}</span><span class="item-pill">${formatDate(app.borrowDate)} 借出</span><span class="item-pill">${formatDate(app.returnDate)} 归还</span>${state.role === "admin" ? `<span class="item-pill">学号 ${esc(app.studentId || "未填写")}</span><span class="item-pill">${esc(app.className || "班级未填写")}</span><span class="item-pill">电话 ${esc(app.phone || "未填写")}</span>` : ""}</div>
      <div class="notice ${app.status === "rejected" ? "notice-danger" : ""}">${esc(app.note || app.purpose)}${app.status === "rejected" && state.role === "user" ? `<br>管理员电话：${esc(state.settings.adminPhone || "暂未配置")}` : ""}</div>
      ${(app.decisionHistory || []).length > 1 ? `<div class="notice notice-warning">审批决定已修改 ${app.decisionHistory.length - 1} 次。最近一次：${esc(app.decisionHistory.at(-1).operator)} 于 ${formatDate(app.decisionHistory.at(-1).at, true)} 改为“${statusLabels[app.decisionHistory.at(-1).to]?.[0] || app.decisionHistory.at(-1).to}”。</div>` : ""}
      <div class="application-actions"><span>用途：${esc(app.purpose)}</span><div class="button-group">${actionButtons}</div></div>
    </article>`;
  }

  function eligibleApplications(action) {
    const status = action === "borrow" ? "approved" : "borrowed";
    return state.applications.filter(app => app.status === status && (state.role === "admin" || app.applicant === state.currentUser.name));
  }

  function renderCapture() {
    const eligible = eligibleApplications(captureDraft.action);
    if (!eligible.some(app => app.id === captureDraft.applicationId)) captureDraft.applicationId = eligible[0]?.id || "";
    const application = applicationById(captureDraft.applicationId);
    const item = application ? inventoryById(application.inventoryId) : null;
    const hasResults = captureDraft.results.length > 0;
    const flowStep = hasResults ? 3 : captureDraft.photoData ? 2 : 1;

    return `${pageHead("Photo check-in / check-out", "拍照识别借还", "选择已批准的申请，上传拍摄区照片；AI 结果提交后等待管理员复核。")}
      <div class="flow-strip">
        ${[[1,"选择申请","关联账号与申请单"],[2,"上传照片","固定拍摄区"],[3,"AI 识别","种类与数量"],[4,"人工复核","确认后更新库存"]].map(([index, title, text]) => `<div class="flow-node ${flowStep === index ? "active" : ""}" data-index="0${index}"><strong>${title}</strong><small>${text}</small></div>`).join("")}
      </div>
      <section class="card">
        <header class="card-head"><div><h2>借还任务</h2><p>AI 识别为演示适配器，可替换为真实模型接口</p></div><div class="filter-chips"><button class="chip ${captureDraft.action === "borrow" ? "active" : ""}" data-action="set-capture-mode" data-mode="borrow">借出</button><button class="chip ${captureDraft.action === "return" ? "active" : ""}" data-action="set-capture-mode" data-mode="return">归还</button></div></header>
        <div class="card-body">
          ${eligible.length ? `<div class="form-grid">
            <div class="field field-full"><label for="capture-application">关联申请</label><select id="capture-application">${eligible.map(app => `<option value="${app.id}" ${app.id === captureDraft.applicationId ? "selected" : ""}>${app.id} · ${esc(app.applicant)} · ${esc(inventoryById(app.inventoryId)?.name)} × ${app.quantity}</option>`).join("")}</select></div>
          </div>
          <div class="spacer-20"></div>
          <div class="two-column">
            <div>
              <div id="photo-drop" class="photo-drop ${captureDraft.photoData ? "has-image" : ""}">
                ${captureDraft.photoData ? `<img src="${captureDraft.photoData}" alt="已上传的借还物资照片">` : ""}
                <div class="photo-placeholder"><strong>上传固定拍摄区照片</strong><span>支持 JPG、PNG；上传后会压缩保存在本机浏览器</span><div class="spacer-12"></div><button type="button" class="button button-secondary button-small" data-action="use-demo-photo">使用演示照片占位</button></div>
                <input id="photo-input" class="photo-input" type="file" accept="image/*" aria-label="上传借还物资照片" ${captureDraft.photoData ? "disabled" : ""}>
                <div class="photo-toolbar"><button data-action="clear-photo">更换照片</button></div>
              </div>
              <div class="spacer-12"></div>
              <div class="notice notice-warning">请把物资完整放入画面并尽量避免遮挡。识别结果不会直接改变库存。</div>
            </div>
            <div class="card" style="margin:0">
              <header class="card-head"><div><h3>AI 识别结果</h3><p>${item ? `${esc(item.name)} · 申请 ${application.quantity} 件` : "先选择申请"}</p></div>${hasResults ? `<span class="badge badge-warning">待提交复核</span>` : ""}</header>
              <div class="card-body recognition-panel">${renderRecognitionContent()}</div>
            </div>
          </div>
          ${captureDraft.action === "return" ? `<div class="spacer-20"></div><div class="card" style="margin:0"><header class="card-head"><div><h3>归还报损</h3><p>如有损坏或丢失，请在归还时正式申报</p></div><label class="check-line"><input id="damage-toggle" type="checkbox" ${captureDraft.damage ? "checked" : ""}> 存在物品缺损</label></header>${captureDraft.damage ? `<div class="card-body"><div class="form-grid"><div class="field"><label for="damage-qty">涉及数量 *</label><input id="damage-qty" type="number" min="1" max="${application?.quantity || 1}" value="${captureDraft.damage.quantity || 1}" required></div><div class="field field-full"><label for="damage-description">缺损情况说明 *</label><textarea id="damage-description" placeholder="说明损坏、丢失或其他异常情况" required>${esc(captureDraft.damage.description || "")}</textarea><span class="field-note">管理员复核后决定回库、标记缺损或报废。</span></div></div></div>` : ""}</div>` : ""}
          <div class="form-footer"><button class="button button-secondary" data-action="clear-capture">清空</button><button class="button button-primary" data-action="submit-recognition" ${!hasResults || captureDraft.scanning ? "disabled" : ""}>提交管理员复核</button></div>`
          : emptyState("00", captureDraft.action === "borrow" ? "没有可借出的已批准申请" : "没有可归还的借出记录", state.role === "admin" ? "先到申请审批页处理申请，或切换另一种操作。" : "借用申请获批后即可开始拍照借出。", `<button class="button button-secondary" data-action="navigate" data-view="applications">查看申请</button>`) }
        </div>
      </section>`;
  }

  function renderRecognitionContent() {
    if (captureDraft.scanning) return `<div class="scan-state"><div class="scan-line"></div><strong>正在识别物资</strong><span>演示适配器正在分析种类与数量…</span></div>`;
    if (!captureDraft.results.length) return `<div class="scan-state"><div class="empty-symbol">AI</div><strong>等待照片</strong><span>上传照片后点击下方按钮开始识别。</span><div class="spacer-12"></div><button class="button button-primary button-small" data-action="run-recognition" ${!captureDraft.photoData ? "disabled" : ""}>开始 AI 识别</button></div>`;
    return `<div class="result-list">${captureDraft.results.map((result, index) => resultEditor(result, index, true)).join("")}</div><div class="spacer-12"></div><button class="button button-secondary button-small button-block" data-action="add-result">添加识别项</button>`;
  }

  function resultEditor(result, index, removable) {
    return `<div class="result-row" data-result-index="${index}">
      <div><label>物资种类</label><select class="result-item">${state.inventory.map(item => `<option value="${item.id}" ${item.id === result.inventoryId ? "selected" : ""}>${esc(item.name)}</option>`).join("")}</select></div>
      <div><label>数量</label><input class="result-qty" type="number" min="1" max="999" value="${result.quantity}"></div>
      <div class="confidence">置信度 ${Math.round((result.confidence || .5) * 100)}%</div>
      ${removable ? `<button class="result-remove" data-action="remove-result" data-index="${index}">移除此项</button>` : ""}
    </div>`;
  }

  function renderReview() {
    if (state.role !== "admin") return deniedState();
    const pending = state.transactions.filter(item => item.status === "pending_review").sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
    return `${pageHead("Human verification", "识别复核", "对照原始照片检查 AI 结果。只有确认后才会更新库存。")}
      <section class="application-list">
        ${pending.length ? pending.map(transaction => {
          const app = applicationById(transaction.applicationId);
          return `<article class="application-card">
            <div class="application-top"><div><h3>${transaction.action === "borrow" ? "借出" : "归还"} · ${esc(transaction.id)}</h3><div class="application-meta">${esc(app?.applicant || "未知用户")} · ${formatDate(transaction.createdAt, true)}</div></div><span class="badge badge-warning">待人工复核</span></div>
            <div class="application-items">${transaction.aiResults.map(result => `<span class="item-pill">${esc(inventoryById(result.inventoryId)?.name)} × ${result.quantity} · ${Math.round(result.confidence * 100)}%</span>`).join("")}</div>
            <div class="application-actions"><span>关联申请：${esc(transaction.applicationId)}</span><div class="button-group"><button class="button button-small button-primary" data-action="open-review" data-id="${transaction.id}">查看照片并复核</button></div></div>
          </article>`;
        }).join("") : `<div class="card">${emptyState("OK", "没有待复核记录", "用户提交的识别结果会出现在这里。", `<button class="button button-secondary" data-action="navigate" data-view="capture">前往拍照借还</button>`)}</div>`}
      </section>`;
  }

  function renderBlacklist() {
    if (state.role !== "admin") return deniedState();
    const entries = [...state.blacklist].sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
    return `${pageHead("User restrictions", "黑名单管理", "管理员手动拉黑或解除用户，并处理用户申诉；所有操作保留记录。")}
      <section class="card"><header class="card-head"><div><h2>黑名单与历史</h2><p>可从申请审批页将申请人加入黑名单</p></div><span class="badge badge-neutral">${entries.filter(item => item.active).length} 人生效中</span></header>
      ${entries.length ? `<div class="application-list card-body">${entries.map(entry => `<article class="application-card"><div class="application-top"><div><h3>${esc(entry.userName)}</h3><div class="application-meta">学号 ${esc(entry.studentId || "未填写")} · ${formatDate(entry.createdAt, true)} · ${esc(entry.createdBy)}</div></div><span class="badge badge-${entry.active ? "danger" : "neutral"}">${entry.active ? "黑名单生效中" : "已解除"}</span></div><div class="notice notice-danger">${esc(entry.reason)}</div>${entry.appeal ? `<div class="notice notice-warning"><strong>申诉：</strong>${esc(entry.appeal.text)}<br>状态：${({pending:"待处理",approved:"已通过",rejected:"未通过"}[entry.appeal.status] || entry.appeal.status)}</div>` : ""}<div class="application-actions"><span>${entry.removedAt ? `解除：${formatDate(entry.removedAt, true)} · ${esc(entry.removedBy)}` : "无自动期限"}</span><div class="button-group">${entry.active && entry.appeal?.status === "pending" ? `<button class="button button-small button-secondary" data-action="reject-appeal" data-id="${entry.id}">驳回申诉</button><button class="button button-small button-primary" data-action="approve-appeal" data-id="${entry.id}">通过并解除</button>` : ""}${entry.active ? `<button class="button button-small button-danger" data-action="remove-blacklist" data-id="${entry.id}">解除黑名单</button>` : ""}</div></div></article>`).join("")}</div>` : emptyState("00", "暂无黑名单记录", "在申请审批页选择申请人并填写原因即可加入。", `<button class="button button-secondary" data-action="navigate" data-view="applications">前往申请审批</button>`)}</section>`;
  }

  function renderDamageRecords() {
    if (state.role !== "admin") return deniedState();
    const reports = state.transactions.filter(item => item.damageReport).sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
    const actionLabel = { mark_damaged: "标记缺损待处理", retire: "报废并减少总库存", restock: "核实后正常回库" };
    return `${pageHead("Damage reports", "报损记录", "查看申请人归还时提交的缺损通知及管理员库存处理结果。")}
      <section class="application-list">${reports.length ? reports.map(tx => { const app = applicationById(tx.applicationId); const report = tx.damageReport; return `<article class="application-card"><div class="application-top"><div><h3>${esc(tx.id)}</h3><div class="application-meta">${esc(app?.applicant || "未知用户")} · ${esc(app?.studentId || "无学号")} · ${formatDate(report.reportedAt, true)}</div></div><span class="badge badge-${report.status === "confirmed" ? "success" : "warning"}">${report.status === "confirmed" ? "已处理" : "待复核"}</span></div><div class="application-items"><span class="item-pill">${esc(inventoryById(app?.inventoryId)?.name || "未知物资")} × ${report.quantity}</span></div><div class="notice notice-danger">${esc(report.description)}</div><div class="application-actions"><span>${report.inventoryAction ? `库存处理：${actionLabel[report.inventoryAction]}` : "等待管理员复核"}</span>${report.status !== "confirmed" ? `<button class="button button-small button-primary" data-action="open-review" data-id="${tx.id}">前往复核</button>` : ""}</div></article>`; }).join("") : `<div class="card">${emptyState("00", "暂无报损记录", "归还时勾选物品缺损并提交后，记录会显示在这里。", "")}</div>`}</section>`;
  }

  function renderRecords() {
    if (state.role !== "admin") return deniedState();
    const records = [...state.records].sort((a,b) => new Date(b.confirmedAt) - new Date(a.confirmedAt));
    return `${pageHead("Audit trail", "借还记录", "保留申请、照片、AI 原始结果与管理员最终确认结果。")}
      <section class="card">
        <header class="card-head"><div><h2>操作留痕</h2><p>当前记录保存在本机浏览器</p></div><span class="badge badge-neutral">共 ${records.length} 条</span></header>
        ${records.length ? `<div style="overflow:auto"><table class="record-table"><thead><tr><th>记录</th><th>申请人</th><th>物资</th><th>动作</th><th>确认时间</th><th></th></tr></thead><tbody>${records.map(record => {
          const app = applicationById(record.applicationId);
          return `<tr><td data-label="记录"><strong>${esc(record.id)}</strong><small>${esc(record.applicationId)}</small></td><td data-label="申请人">${esc(app?.applicant || "—")}<small>${esc(app?.department || "")}</small></td><td data-label="物资">${record.finalResults.map(result => `${esc(inventoryById(result.inventoryId)?.name)} × ${result.quantity}`).join("、")}</td><td data-label="动作">${record.action === "borrow" ? `<span class="badge badge-info">借出</span>` : `<span class="badge badge-success">归还</span>`}</td><td data-label="确认时间">${formatDate(record.confirmedAt, true)}</td><td><button class="action-link" data-action="view-record" data-id="${record.id}">详情</button></td></tr>`;
        }).join("")}</tbody></table></div>` : emptyState("00", "暂无借还记录", "管理员确认识别结果后，会自动生成留痕记录。", "")}
      </section>`;
  }

  function emptyState(symbol, title, description, action) {
    return `<div class="empty-state"><div><div class="empty-symbol">${esc(symbol)}</div><h3>${esc(title)}</h3><p>${esc(description)}</p>${action}</div></div>`;
  }

  function deniedState() {
    return `${pageHead("Access control", "无权访问", "请切换到具有相应权限的演示身份。")}<div class="card">${emptyState("403", "当前身份无权查看", "使用右上角身份切换后再试。", `<button class="button button-secondary" data-action="navigate" data-view="inventory">返回库存</button>`)}</div>`;
  }

  function openModal(content) {
    modalRoot.innerHTML = `<div class="modal-backdrop"><div class="modal" role="dialog" aria-modal="true">${content}</div></div>`;
  }

  function closeModal() {
    modalRoot.innerHTML = "";
  }

  function settingsModal() {
    openModal(`<header class="modal-head"><h2>演示设置</h2><button class="icon-button" data-action="close-modal" aria-label="关闭">×</button></header>
      <div class="modal-body"><div class="notice">第一版把数据保存在当前浏览器中，不会上传到服务器。</div><div class="spacer-20"></div><div class="summary-list"><div class="summary-item"><span>当前身份</span><strong>${state.role === "admin" ? "物资管理员" : state.currentUser.name}</strong></div><div class="summary-item"><span>库存类别</span><strong>${state.inventory.length} 类</strong></div><div class="summary-item"><span>申请记录</span><strong>${state.applications.length} 条</strong></div><div class="summary-item"><span>借还留痕</span><strong>${state.records.length} 条</strong></div></div></div>
      <footer class="modal-footer"><button class="button button-danger" data-action="reset-demo">重置演示数据</button><button class="button button-secondary" data-action="close-modal">关闭</button></footer>`);
  }

  function editInventoryModal(id) {
    const item = inventoryById(id);
    if (!item) return;
    openModal(`<form id="inventory-form" data-id="${item.id}"><header class="modal-head"><h2>编辑 ${esc(item.name)}</h2><button type="button" class="icon-button" data-action="close-modal" aria-label="关闭">×</button></header>
      <div class="modal-body"><div class="form-grid"><div class="field"><label>总数量</label><input name="total" type="number" min="0" value="${item.total}" required></div><div class="field"><label>可用数量</label><input name="available" type="number" min="0" value="${item.available}" required></div><div class="field"><label>缺损待处理</label><input name="damaged" type="number" min="0" value="${item.damaged || 0}" required></div><div class="field field-full"><label>存放位置</label><input name="location" value="${esc(item.location)}" required></div></div></div>
      <footer class="modal-footer"><button type="button" class="button button-secondary" data-action="close-modal">取消</button><button class="button button-primary" type="submit">保存库存</button></footer></form>`);
  }

  function rejectModal(id) {
    const app = applicationById(id);
    if (!app) return;
    openModal(`<form id="reject-form" data-id="${app.id}"><header class="modal-head"><h2>拒绝申请</h2><button type="button" class="icon-button" data-action="close-modal" aria-label="关闭">×</button></header>
      <div class="modal-body"><div class="field"><label>拒绝原因</label><textarea name="note" placeholder="说明库存、时间或用途等原因" required></textarea></div></div>
      <footer class="modal-footer"><button type="button" class="button button-secondary" data-action="close-modal">取消</button><button class="button button-danger" type="submit">确认拒绝</button></footer></form>`);
  }

  function contactModal() {
    openModal(`<header class="modal-head"><h2>管理员联系方式</h2><button class="icon-button" data-action="close-modal" aria-label="关闭">×</button></header>
      <div class="modal-body"><div class="notice">借还、审批或报损问题可直接联系物资管理员。</div><div class="spacer-20"></div><div class="summary-list"><div class="summary-item"><span>联系电话</span><strong>${esc(state.settings.adminPhone || "暂未配置")}</strong></div></div>${state.role === "admin" ? `<div class="spacer-20"></div><form id="contact-form"><div class="field"><label>修改管理员电话</label><input name="adminPhone" inputmode="tel" value="${esc(state.settings.adminPhone || "")}" required></div><div class="form-footer"><button class="button button-primary" type="submit">保存电话</button></div></form>` : ""}</div>
      <footer class="modal-footer"><button class="button button-secondary" data-action="close-modal">关闭</button></footer>`);
  }

  function modifyDecisionModal(id) {
    const app = applicationById(id);
    if (!app || !["approved", "rejected"].includes(app.status)) return;
    const lastDecision = (app.decisionHistory || []).at(-1);
    if (lastDecision && lastDecision.operator !== state.currentAdmin.name) return showToast("只能修改自己做出的审批决定。", "error");
    const next = app.status === "approved" ? "rejected" : "approved";
    openModal(`<form id="modify-decision-form" data-id="${app.id}" data-next="${next}"><header class="modal-head"><h2>修改审批决定</h2><button type="button" class="icon-button" data-action="close-modal" aria-label="关闭">×</button></header>
      <div class="modal-body"><div class="notice notice-warning">当前决定：${statusLabels[app.status][0]}；修改后申请人会看到改判提示，原决定会保留在历史中。</div><div class="spacer-20"></div><div class="field"><label>新决定</label><input value="${next === "approved" ? "批准" : "拒绝"}" readonly></div>${next === "rejected" ? `<div class="spacer-12"></div><div class="field"><label>拒绝理由 *</label><textarea name="reason" required placeholder="请填写申请人可见的具体理由"></textarea></div>` : ""}</div>
      <footer class="modal-footer"><button type="button" class="button button-secondary" data-action="close-modal">取消</button><button class="button button-primary" type="submit">确认修改</button></footer></form>`);
  }

  function blacklistModal(applicationId) {
    const app = applicationById(applicationId);
    if (!app) return;
    const existing = state.blacklist.find(entry => entry.active && (entry.studentId === app.studentId || entry.userName === app.applicant));
    if (existing) return showToast("该申请人已经在黑名单中。", "error");
    openModal(`<form id="blacklist-form" data-application-id="${app.id}"><header class="modal-head"><h2>加入黑名单</h2><button type="button" class="icon-button" data-action="close-modal" aria-label="关闭">×</button></header>
      <div class="modal-body"><div class="summary-list"><div class="summary-item"><span>申请人</span><strong>${esc(app.applicant)}</strong></div><div class="summary-item"><span>学号</span><strong>${esc(app.studentId || "未填写")}</strong></div></div><div class="spacer-20"></div><div class="field"><label>拉黑原因 *</label><textarea name="reason" required placeholder="该原因会对申请人完整可见"></textarea></div></div>
      <footer class="modal-footer"><button type="button" class="button button-secondary" data-action="close-modal">取消</button><button class="button button-danger" type="submit">确认加入黑名单</button></footer></form>`);
  }

  function decisionHistoryModal(id) {
    const app = applicationById(id);
    if (!app) return;
    const rows = (app.decisionHistory || []).map(entry => `<div class="summary-item"><span>${formatDate(entry.at, true)} · ${esc(entry.operator)}</span><strong>${statusLabels[entry.from]?.[0] || entry.from} → ${statusLabels[entry.to]?.[0] || entry.to}${entry.reason ? `<br><small>${esc(entry.reason)}</small>` : ""}</strong></div>`).join("");
    openModal(`<header class="modal-head"><h2>审批历史</h2><button class="icon-button" data-action="close-modal" aria-label="关闭">×</button></header><div class="modal-body"><div class="summary-list">${rows || `<div class="muted">暂无审批记录</div>`}</div></div><footer class="modal-footer"><button class="button button-secondary" data-action="close-modal">关闭</button></footer>`);
  }

  function appealModal(id) {
    const entry = state.blacklist.find(item => item.id === id && item.active);
    if (!entry) return;
    openModal(`<form id="appeal-form" data-id="${entry.id}"><header class="modal-head"><h2>提交黑名单申诉</h2><button type="button" class="icon-button" data-action="close-modal" aria-label="关闭">×</button></header><div class="modal-body"><div class="notice notice-danger">拉黑原因：${esc(entry.reason)}</div><div class="spacer-20"></div><div class="field"><label>申诉说明 *</label><textarea name="text" required placeholder="说明情况及申请解除的理由"></textarea></div></div><footer class="modal-footer"><button type="button" class="button button-secondary" data-action="close-modal">取消</button><button class="button button-primary" type="submit">提交申诉</button></footer></form>`);
  }

  function reviewModal(id) {
    const transaction = state.transactions.find(item => item.id === id);
    if (!transaction) return;
    const app = applicationById(transaction.applicationId);
    openModal(`<form id="review-form" data-id="${transaction.id}">
      <header class="modal-head"><div><h2>${transaction.action === "borrow" ? "借出" : "归还"}识别复核</h2><p class="application-meta">${esc(app?.applicant)} · ${esc(transaction.applicationId)}</p></div><button type="button" class="icon-button" data-action="close-modal" aria-label="关闭">×</button></header>
      <div class="modal-body">
        <div class="photo-drop has-image"><img src="${transaction.photoData}" alt="借还物资原始照片"><div class="photo-toolbar" style="display:none"></div></div>
        <div class="spacer-20"></div>
        <div class="notice notice-warning">请对照照片修改种类和数量。确认后将${transaction.action === "borrow" ? "扣减" : "增加"}库存，且不能重复确认。</div>
        ${transaction.damageReport ? `<div class="spacer-12"></div><div class="notice notice-danger"><strong>申请人申报缺损 ${transaction.damageReport.quantity} 件：</strong>${esc(transaction.damageReport.description)}</div><div class="spacer-12"></div><div class="field"><label>管理员库存处理 *</label><select name="damageAction" required><option value="mark_damaged">完好部分回库，缺损部分标记待处理</option><option value="retire">完好部分回库，缺损部分报废并减少总库存</option><option value="restock">核实后全部正常回库</option></select></div>` : ""}
        <div class="spacer-20"></div>
        <div id="review-results" class="result-list">${transaction.aiResults.map((result, index) => resultEditor(result, index, false)).join("")}</div>
      </div>
      <footer class="modal-footer"><button type="button" class="button button-secondary" data-action="close-modal">稍后处理</button><button type="submit" class="button button-primary">确认并更新库存</button></footer>
    </form>`);
  }

  function recordModal(id) {
    const record = state.records.find(item => item.id === id);
    if (!record) return;
    const app = applicationById(record.applicationId);
    const rows = (results) => results.map(result => `${esc(inventoryById(result.inventoryId)?.name)} × ${result.quantity}`).join("、");
    openModal(`<header class="modal-head"><h2>借还记录详情</h2><button class="icon-button" data-action="close-modal" aria-label="关闭">×</button></header>
      <div class="modal-body"><div class="photo-drop has-image"><img src="${record.photoData}" alt="借还物资原始照片"></div><div class="spacer-20"></div><div class="summary-list"><div class="summary-item"><span>记录编号</span><strong>${esc(record.id)}</strong></div><div class="summary-item"><span>关联申请</span><strong>${esc(record.applicationId)}</strong></div><div class="summary-item"><span>申请人</span><strong>${esc(app?.applicant || "—")}</strong></div><div class="summary-item"><span>动作</span><strong>${record.action === "borrow" ? "借出" : "归还"}</strong></div><div class="summary-item"><span>AI 原始结果</span><strong>${rows(record.aiResults)}</strong></div><div class="summary-item"><span>管理员确认</span><strong>${rows(record.finalResults)}</strong></div>${record.damageReport ? `<div class="summary-item"><span>报损说明</span><strong>${esc(record.damageReport.description)}（${record.damageReport.quantity} 件）</strong></div>` : ""}<div class="summary-item"><span>确认时间</span><strong>${formatDate(record.confirmedAt, true)}</strong></div></div></div>
      <footer class="modal-footer"><button class="button button-secondary" data-action="close-modal">关闭</button></footer>`);
  }

  function approveApplication(id) {
    const app = applicationById(id);
    const item = app && inventoryById(app.inventoryId);
    if (!app || app.status !== "pending") return;
    if (!item || item.available < app.quantity) {
      showToast("当前可用库存不足，无法批准该申请。", "error");
      return;
    }
    app.status = "approved";
    app.note = "申请已批准，请按预约日期到固定拍摄区领取并拍照。";
    app.approvedAt = new Date().toISOString();
    app.decisionHistory = app.decisionHistory || [];
    app.decisionHistory.push({ from: "pending", to: "approved", at: app.approvedAt, operator: state.currentAdmin.name, reason: "" });
    saveState();
    render();
    showToast("申请已批准，等待申请人拍照领取。" );
  }

  function updateBlacklist(id, operation) {
    const entry = state.blacklist.find(item => item.id === id);
    if (!entry) return;
    if (operation === "removed" || operation === "appeal-approved") {
      entry.active = false;
      entry.removedAt = new Date().toISOString();
      entry.removedBy = state.currentAdmin.name;
      if (operation === "appeal-approved" && entry.appeal) {
        entry.appeal.status = "approved";
        entry.appeal.decidedAt = entry.removedAt;
        entry.appeal.decidedBy = state.currentAdmin.name;
      }
      showToast("黑名单已解除。" );
    }
    if (operation === "appeal-rejected" && entry.appeal) {
      entry.appeal.status = "rejected";
      entry.appeal.decidedAt = new Date().toISOString();
      entry.appeal.decidedBy = state.currentAdmin.name;
      showToast("申诉已驳回。" );
    }
    saveState();
    render();
  }

  function submitApplication(form) {
    const data = new FormData(form);
    if (activeBlacklistForUser()) return showToast("该账号已被列入黑名单，暂时无法提交申请。", "error");
    const inventory = inventoryById(data.get("inventoryId"));
    const quantity = Number(data.get("quantity"));
    const borrowDate = data.get("borrowDate");
    const returnDate = data.get("returnDate");
    const phone = String(data.get("phone")).trim();
    const studentId = String(data.get("studentId")).trim();
    const className = String(data.get("className")).trim();
    if (!/^1[3-9]\d{9}$/.test(phone)) return showToast("请输入正确的 11 位手机号。", "error");
    if (!/^\d{10}$/.test(studentId)) return showToast("学号必须为 10 位数字。", "error");
    if (!className) return showToast("请填写行政班级。", "error");
    if (!inventory || quantity < 1 || quantity > inventory.available) return showToast("申请数量超出当前可用库存。", "error");
    if (returnDate < borrowDate) return showToast("预计归还日期不能早于借用日期。", "error");
    state.applications.push({
      id: `REQ-${new Date().toISOString().slice(2,10).replaceAll("-","")}-${String(state.applications.length + 1).padStart(2,"0")}`,
      applicant: state.currentUser.name,
      department: String(data.get("department")).trim(),
      phone,
      studentId,
      className,
      inventoryId: inventory.id,
      quantity,
      borrowDate,
      returnDate,
      purpose: String(data.get("purpose")).trim(),
      status: "pending",
      note: "",
      decisionHistory: [],
      createdAt: new Date().toISOString()
    });
    Object.assign(state.currentUser, { department: String(data.get("department")).trim(), phone, studentId, className });
    saveState();
    navigate("applications");
    showToast("借用申请已提交，等待管理员审批。" );
  }

  async function compressImage(file) {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    const image = await new Promise((resolve, reject) => {
      const node = new Image();
      node.onload = () => resolve(node);
      node.onerror = reject;
      node.src = dataUrl;
    });
    const max = 900;
    const scale = Math.min(1, max / Math.max(image.width, image.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", .74);
  }

  function makeDemoPhoto() {
    const app = applicationById(captureDraft.applicationId);
    const item = app ? inventoryById(app.inventoryId) : null;
    const canvas = document.createElement("canvas");
    canvas.width = 900;
    canvas.height = 600;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#e7e5dd";
    ctx.fillRect(0, 0, 900, 600);
    ctx.strokeStyle = "#174c3a";
    ctx.lineWidth = 4;
    ctx.setLineDash([18, 12]);
    ctx.strokeRect(58, 58, 784, 484);
    ctx.setLineDash([]);
    ctx.fillStyle = "#174c3a";
    ctx.font = "700 42px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("演示照片占位", 450, 246);
    ctx.fillStyle = "#53625a";
    ctx.font = "28px sans-serif";
    ctx.fillText(`${item?.name || "物资"} × ${app?.quantity || 1}`, 450, 304);
    ctx.font = "20px sans-serif";
    ctx.fillText("实际使用时请上传固定拍摄区照片", 450, 360);
    return canvas.toDataURL("image/jpeg", .78);
  }

  function runRecognition() {
    const app = applicationById(captureDraft.applicationId);
    if (!app || !captureDraft.photoData) return;
    captureDraft.scanning = true;
    render();
    setTimeout(() => {
      captureDraft.scanning = false;
      captureDraft.results = [{ inventoryId: app.inventoryId, quantity: app.quantity, confidence: .91 }];
      render();
      showToast("识别完成，请检查种类和数量。" );
    }, 850);
  }

  function syncCaptureResultsFromDom(container = viewRoot) {
    const rows = container.querySelectorAll(".result-row");
    return [...rows].map(row => ({
      inventoryId: row.querySelector(".result-item").value,
      quantity: Math.max(1, Number(row.querySelector(".result-qty").value) || 1),
      confidence: captureDraft.results[Number(row.dataset.resultIndex)]?.confidence || .5
    }));
  }

  function submitRecognition() {
    if (!captureDraft.photoData || !captureDraft.applicationId || !captureDraft.results.length) return;
    captureDraft.results = syncCaptureResultsFromDom();
    const app = applicationById(captureDraft.applicationId);
    if (!app) return;
    if (captureDraft.action === "return" && captureDraft.damage) {
      const quantity = Math.max(1, Number(document.getElementById("damage-qty")?.value) || 0);
      const description = String(document.getElementById("damage-description")?.value || "").trim();
      if (!description) return showToast("请填写缺损情况说明。", "error");
      if (quantity > app.quantity) return showToast("报损数量不能超过本次归还数量。", "error");
      captureDraft.damage = { quantity, description, status: "pending", reportedAt: new Date().toISOString() };
    }
    const id = `TX-${Date.now().toString().slice(-8)}`;
    state.transactions.push({
      id,
      applicationId: app.id,
      action: captureDraft.action,
      photoData: captureDraft.photoData,
      aiResults: captureDraft.results.map(item => ({ ...item })),
      damageReport: captureDraft.damage ? { ...captureDraft.damage } : null,
      status: "pending_review",
      createdAt: new Date().toISOString()
    });
    app.status = captureDraft.action === "borrow" ? "awaiting_borrow_review" : "awaiting_return_review";
    captureDraft = { applicationId: "", action: "borrow", photoData: "", results: [], scanning: false, damage: null };
    saveState();
    state.role = "admin";
    navigate("review");
    showToast("识别结果已提交，已切换到管理员复核。" );
  }

  function confirmReview(form) {
    const transaction = state.transactions.find(item => item.id === form.dataset.id);
    if (!transaction || transaction.status !== "pending_review") return showToast("该记录已经处理，不能重复确认。", "error");
    const finalResults = [...form.querySelectorAll(".result-row")].map(row => ({
      inventoryId: row.querySelector(".result-item").value,
      quantity: Math.max(1, Number(row.querySelector(".result-qty").value) || 1)
    }));
    for (const result of finalResults) {
      const item = inventoryById(result.inventoryId);
      if (!item) return showToast("复核结果包含未知物资。", "error");
      if (transaction.action === "borrow" && item.available < result.quantity) return showToast(`${item.name} 可用库存不足，无法确认借出。`, "error");
    }
    const damageAction = transaction.damageReport ? new FormData(form).get("damageAction") : null;
    finalResults.forEach(result => {
      const item = inventoryById(result.inventoryId);
      if (transaction.action === "borrow") {
        item.available -= result.quantity;
      } else if (transaction.damageReport && result.inventoryId === applicationById(transaction.applicationId)?.inventoryId) {
        const damagedQty = Math.min(transaction.damageReport.quantity, result.quantity);
        const goodQty = result.quantity - damagedQty;
        if (damageAction === "restock") item.available = Math.min(item.total, item.available + result.quantity);
        if (damageAction === "mark_damaged") {
          item.available = Math.min(item.total, item.available + goodQty);
          item.damaged = (item.damaged || 0) + damagedQty;
        }
        if (damageAction === "retire") {
          item.total = Math.max(0, item.total - damagedQty);
          item.available = Math.min(item.total, item.available + goodQty);
        }
      } else {
        item.available = Math.min(item.total, item.available + result.quantity);
      }
    });
    transaction.status = "confirmed";
    transaction.finalResults = finalResults;
    transaction.confirmedAt = new Date().toISOString();
    if (transaction.damageReport) {
      transaction.damageReport.status = "confirmed";
      transaction.damageReport.inventoryAction = damageAction;
      transaction.damageReport.reviewedAt = transaction.confirmedAt;
      transaction.damageReport.reviewedBy = state.currentAdmin.name;
    }
    const app = applicationById(transaction.applicationId);
    if (app) app.status = transaction.action === "borrow" ? "borrowed" : "returned";
    state.records.push({
      id: `REC-${Date.now().toString().slice(-8)}`,
      transactionId: transaction.id,
      applicationId: transaction.applicationId,
      action: transaction.action,
      photoData: transaction.photoData,
      aiResults: transaction.aiResults.map(item => ({ ...item })),
      finalResults: finalResults.map(item => ({ ...item })),
      damageReport: transaction.damageReport ? { ...transaction.damageReport } : null,
      confirmedAt: transaction.confirmedAt
    });
    saveState();
    closeModal();
    render();
    showToast(`复核完成，库存已${transaction.action === "borrow" ? "扣减" : "增加"}并生成记录。` );
  }

  document.addEventListener("click", event => {
    if (event.target.classList?.contains("modal-backdrop")) {
      closeModal();
      return;
    }
    const target = event.target.closest("[data-action]");
    if (!target) return;
    const action = target.dataset.action;
    if (action === "navigate") navigate(target.dataset.view);
    if (action === "set-role") {
      state.role = target.dataset.role;
      state.currentView = "inventory";
      saveState();
      render();
      showToast(`已切换为${state.role === "admin" ? "管理员" : "普通用户"}身份。` );
    }
    if (action === "quick-apply") {
      sessionStorage.setItem("quickApplyItem", target.dataset.id);
      navigate("apply");
    }
    if (action === "filter-inventory") {
      inventoryFilter = target.dataset.filter;
      render();
    }
    if (action === "edit-inventory") editInventoryModal(target.dataset.id);
    if (action === "show-contact") contactModal();
    if (action === "approve-application") approveApplication(target.dataset.id);
    if (action === "reject-application") rejectModal(target.dataset.id);
    if (action === "modify-decision") modifyDecisionModal(target.dataset.id);
    if (action === "decision-history") decisionHistoryModal(target.dataset.id);
    if (action === "blacklist-applicant") blacklistModal(target.dataset.id);
    if (action === "appeal-blacklist") appealModal(target.dataset.id);
    if (action === "remove-blacklist") updateBlacklist(target.dataset.id, "removed");
    if (action === "approve-appeal") updateBlacklist(target.dataset.id, "appeal-approved");
    if (action === "reject-appeal") updateBlacklist(target.dataset.id, "appeal-rejected");
    if (action === "start-capture") {
      captureDraft = { applicationId: target.dataset.id, action: target.dataset.mode, photoData: "", results: [], scanning: false, damage: null };
      navigate("capture");
    }
    if (action === "set-capture-mode") {
      captureDraft = { applicationId: "", action: target.dataset.mode, photoData: "", results: [], scanning: false, damage: null };
      render();
    }
    if (action === "use-demo-photo") {
      event.preventDefault();
      event.stopPropagation();
      captureDraft.photoData = makeDemoPhoto();
      captureDraft.results = [];
      render();
    }
    if (action === "clear-photo") {
      captureDraft.photoData = "";
      captureDraft.results = [];
      render();
    }
    if (action === "clear-capture") {
      captureDraft.photoData = "";
      captureDraft.results = [];
      render();
    }
    if (action === "run-recognition") runRecognition();
    if (action === "remove-result") {
      captureDraft.results = syncCaptureResultsFromDom();
      captureDraft.results.splice(Number(target.dataset.index), 1);
      render();
    }
    if (action === "add-result") {
      captureDraft.results = syncCaptureResultsFromDom();
      captureDraft.results.push({ inventoryId: state.inventory[0].id, quantity: 1, confidence: .5 });
      render();
    }
    if (action === "submit-recognition") submitRecognition();
    if (action === "open-review") reviewModal(target.dataset.id);
    if (action === "view-record") recordModal(target.dataset.id);
    if (action === "open-reset") settingsModal();
    if (action === "close-modal") closeModal();
    if (action === "reset-demo") {
      state = seedState();
      captureDraft = { applicationId: "", action: "borrow", photoData: "", results: [], scanning: false, damage: null };
      saveState();
      closeModal();
      render();
      showToast("演示数据已重置。" );
    }
  });

  document.addEventListener("input", event => {
    if (event.target.id === "inventory-search") {
      searchText = event.target.value;
      const cursor = event.target.selectionStart;
      render();
      const input = document.getElementById("inventory-search");
      input?.focus();
      input?.setSelectionRange(cursor, cursor);
    }
  });

  document.addEventListener("change", async event => {
    if (event.target.id === "damage-toggle") {
      captureDraft.damage = event.target.checked ? { quantity: 1, description: "", status: "draft" } : null;
      render();
      return;
    }
    if (event.target.id === "inventory-id") {
      const item = inventoryById(event.target.value);
      const quantity = document.getElementById("quantity");
      quantity.max = item.available;
      quantity.value = Math.min(Number(quantity.value), item.available || 1);
      document.getElementById("availability-note").textContent = `当前可借 ${item.available} 件`;
      document.getElementById("summary-item").textContent = item.name;
      document.getElementById("summary-location").textContent = item.location;
    }
    if (event.target.id === "capture-application") {
      captureDraft.applicationId = event.target.value;
      captureDraft.photoData = "";
      captureDraft.results = [];
      render();
    }
    if (event.target.id === "photo-input" && event.target.files?.[0]) {
      const file = event.target.files[0];
      if (!file.type.startsWith("image/")) return showToast("请选择图片文件。", "error");
      if (file.size > 12 * 1024 * 1024) return showToast("图片超过 12MB，请先压缩。", "error");
      try {
        captureDraft.photoData = await compressImage(file);
        captureDraft.results = [];
        render();
        showToast("照片已载入并压缩。" );
      } catch (error) {
        console.error(error);
        showToast("照片读取失败，请换一张图片。", "error");
      }
    }
  });

  document.addEventListener("submit", event => {
    event.preventDefault();
    const form = event.target;
    if (form.id === "application-form") submitApplication(form);
    if (form.id === "inventory-form") {
      const item = inventoryById(form.dataset.id);
      const data = new FormData(form);
      const total = Math.max(0, Number(data.get("total")) || 0);
      const available = Math.max(0, Number(data.get("available")) || 0);
      const damaged = Math.max(0, Number(data.get("damaged")) || 0);
      if (available > total) return showToast("可用数量不能大于总数量。", "error");
      if (available + damaged > total) return showToast("可用数量与缺损数量之和不能大于总数量。", "error");
      item.total = total;
      item.available = available;
      item.damaged = damaged;
      item.location = String(data.get("location")).trim();
      saveState();
      closeModal();
      render();
      showToast("库存信息已更新。" );
    }
    if (form.id === "reject-form") {
      const app = applicationById(form.dataset.id);
      const previous = app.status;
      app.status = "rejected";
      app.note = String(new FormData(form).get("note")).trim();
      app.decisionHistory = app.decisionHistory || [];
      app.decisionHistory.push({ from: previous, to: "rejected", at: new Date().toISOString(), operator: state.currentAdmin.name, reason: app.note });
      saveState();
      closeModal();
      render();
      showToast("申请已拒绝。" );
    }
    if (form.id === "contact-form") {
      state.settings.adminPhone = String(new FormData(form).get("adminPhone")).trim();
      saveState();
      closeModal();
      render();
      showToast("管理员电话已更新，所有入口同步生效。" );
    }
    if (form.id === "modify-decision-form") {
      const app = applicationById(form.dataset.id);
      const next = form.dataset.next;
      if (!app || !["approved", "rejected"].includes(app.status)) return showToast("该申请当前不能修改审批决定。", "error");
      const lastDecision = (app.decisionHistory || []).at(-1);
      if (lastDecision && lastDecision.operator !== state.currentAdmin.name) return showToast("只能修改自己做出的审批决定。", "error");
      const previous = app.status;
      const reason = next === "rejected" ? String(new FormData(form).get("reason")).trim() : "";
      if (next === "rejected" && !reason) return showToast("改为拒绝时必须填写理由。", "error");
      app.status = next;
      app.note = next === "approved" ? "审批决定已修改为批准，请按预约日期领取。" : reason;
      app.decisionHistory = app.decisionHistory || [];
      app.decisionHistory.push({ from: previous, to: next, at: new Date().toISOString(), operator: state.currentAdmin.name, reason });
      saveState();
      closeModal();
      render();
      showToast("审批决定已修改，并保留了变更记录。" );
    }
    if (form.id === "blacklist-form") {
      const app = applicationById(form.dataset.applicationId);
      const reason = String(new FormData(form).get("reason")).trim();
      if (!app || !reason) return showToast("请填写拉黑原因。", "error");
      state.blacklist.push({ id: `BL-${Date.now().toString().slice(-8)}`, userName: app.applicant, studentId: app.studentId || "", reason, active: true, createdAt: new Date().toISOString(), createdBy: state.currentAdmin.name, appeal: null });
      saveState();
      closeModal();
      render();
      showToast("申请人已加入黑名单。" );
    }
    if (form.id === "appeal-form") {
      const entry = state.blacklist.find(item => item.id === form.dataset.id && item.active);
      const text = String(new FormData(form).get("text")).trim();
      if (!entry || !text) return showToast("请填写申诉说明。", "error");
      entry.appeal = { text, status: "pending", submittedAt: new Date().toISOString() };
      saveState();
      closeModal();
      render();
      showToast("申诉已提交，等待管理员处理。" );
    }
    if (form.id === "review-form") confirmReview(form);
  });

  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && modalRoot.innerHTML) closeModal();
  });

  render();
})();
