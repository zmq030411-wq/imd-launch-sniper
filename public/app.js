"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const form = $("config-form");
  const decimalFields = [
    "buyAmountEth",
    "maxFeeGwei",
    "priorityFeeGwei",
    "maxGasEth",
    "minLiquidityEth",
  ];
  const integerFields = [
    "minLaunchNumber",
    "maxLaunchAgeSeconds",
    "deadlineSeconds",
    "pollIntervalMs",
  ];
  const percentFields = ["slippageBps", "maxBuyTaxBps", "maxSellTaxBps"];
  const arrayFields = ["rpcHttpUrls", "rpcWsUrls", "allowedHooks"];
  const defaults = {
    discoverySource: "api",
    taxCheck: "off",
    buyAmountEth: "0.01",
    maxFeeGwei: "30",
    priorityFeeGwei: "2",
    feeStrategy: "competitive",
    maxGasEth: "0.005",
    minLiquidityEth: "0",
    minLaunchNumber: 1,
    maxLaunchAgeSeconds: 120,
    deadlineSeconds: 60,
    pollIntervalMs: 2000,
    slippageBps: 300,
    maxBuyTaxBps: 0,
    maxSellTaxBps: 0,
    rpcHttpUrls: [
      "https://ethereum-rpc.publicnode.com",
      "https://eth.drpc.org",
    ],
    rpcWsUrls: ["wss://ethereum-rpc.publicnode.com"],
    allowedHooks: ["0x0000000000000000000000000000000000000000"],
    allowedKinds: ["evm_project", "custom_token", "univ4_hook"],
    startBlock: "0",
    unknownTaxPolicy: "reject",
  };
  let savedConfig = null;
  let latestStatus = null;
  let dirty = false;
  let busy = false;
  let online = false;
  let loaded = false;
  let pollTimer = null;
  let polling = false;
  let logSignature = "";
  let researchSignature = "";
  let liveApproval = null;
  let statusGeneration = 0;
  let pendingStart = null;
  let stopping = false;

  function sameConfig(left, right) {
    const signature = (value) =>
      JSON.stringify(
        Object.keys(value || {})
          .sort()
          .map((key) => [key, value[key]]),
      );
    return signature(left) === signature(right);
  }

  function clearLiveApproval() {
    liveApproval = null;
    $("live-consent").checked = false;
  }

  function approveLive() {
    if (!$("live-consent").checked) {
      liveApproval = null;
      return;
    }
    const walletAddress = latestStatus?.wallet?.address;
    if (
      !online ||
      !latestStatus?.wallet?.configured ||
      !/^0x[0-9a-fA-F]{40}$/.test(walletAddress || "")
    )
      throw new Error("请先加载并核对执行钱包地址，再确认实盘交易。");
    liveApproval = {
      config: collect(),
      walletAddress,
      observedConfig: latestStatus.config || savedConfig,
    };
  }

  function configurationLocked() {
    return (
      Boolean(latestStatus?.running) || latestStatus?.canConfigure === false
    );
  }

  const eventNames = {
    observation_updated: "公开接口已同步",
    observation_error: "公开接口读取失败",
    api_signal: "官方 API 发现变化",
    api_error: "官方 API 读取失败",
    api_baseline: "启动时已有项目已记录",
    api_waiting: "等待新主网代币",
    api_candidate: "官方 API 发现新主网项目",
    scan_error: "链上扫描失败",
    history_audit: "正在核对历史发射",
    history_missed: "首个符合条件的项目已错过",
    boundary_resolved: "监控起点已确定",
    chain_reorg: "检测到链重组",
    ws_error: "实时连接中断",
    quote: "报价已验证",
    broadcast: "交易已广播",
    reverted: "交易已回滚",
    execution_stopped: "执行已停止",
    started: "监听已启动",
    stopped: "监听已停止",
    error: "运行错误",
    warning: "提示",
    candidate: "发现候选项目",
    skipped: "已跳过项目",
    rejected: "未通过筛选",
    submitted: "交易已提交",
    confirmed: "交易已确认",
    pending: "等待链上回执",
    connected: "节点已连接",
    disconnected: "节点已断开",
    launch_discovered: "发现新项目",
    launch_skipped: "项目未通过筛选",
    transaction_submitted: "交易已提交",
    transaction_confirmed: "交易已确认",
    readiness_failed: "就绪检查未通过",
  };
  const phaseNames = {
    idle: "等待启动",
    observing: "观察公开接口",
    watching: "监听链上事件",
    auditing: "正在核对历史发射",
    baselining: "正在记录已有项目",
    validating: "核对主网部署",
    missed: "已错过 · 停止买入",
    selected: "已选中首个候选",
    claimed: "已锁定首个候选",
    signed: "交易已签名",
    broadcast: "已广播 · 等待回执",
    confirmed: "交易已确认",
    failed: "执行失败",
    uncertain: "交易结果待核对",
  };
  const checkNames = {
    rpc: "RPC 网络连接",
    rpcHttp: "HTTP RPC",
    rpcWs: "WebSocket RPC",
    chain: "Ethereum 主网",
    chainId: "链 ID",
    deployment: "官方部署信息",
    manifest: "部署清单",
    signer: "服务器签名钱包",
    privateKey: "服务器签名钱包",
    wallet: "钱包状态",
    balance: "钱包余额",
    tax: "税率校验",
    adapter: "买入交易适配器",
    hooks: "Hook 白名单",
    live: "实盘执行条件",
    startBlock: "监控起点",
    monitor: "监控起点与历史核对",
    discoverySource: "项目发现方式",
    taxCheck: "税率检查方式",
  };
  const monitorNames = {
    "waiting-deployment": "等待官方部署",
    pending: "等待确定起点",
    resolved: "起点已确定",
    auditing: "正在核对历史",
    baselining: "正在准备监听",
    watching: "监听新项目",
    missed: "已错过 · 已停止",
    error: "扫描出现问题",
  };
  const monitorDetails = {
    "waiting-deployment":
      "尚未配置已核实的官方主网发射合约，确认地址与代码后才能开始链上监控。",
    pending: "启动后将查找监控起点并核对历史发射记录。",
    resolved: "监控起点已确定，接下来核对历史记录。",
    auditing: "正在检查启动前是否已有符合条件的项目，此时不会买入。",
    baselining: "正在记录已可交易的项目，完成后只处理新变为可交易的主网项目。",
    watching: "历史核对通过，继续监听首个符合条件的新项目。",
    missed: "启动前已有符合条件的项目，已停止买入，不追买旧币。",
    error: "监控遇到问题，请查看运行记录后处理。",
  };
  const monitorSources = {
    "factory-history": "发射合约部署历史",
    "deployment-hint": "已核实部署资料",
    manual: "手动指定",
    "api-baseline": "官方 API 初始项目记录",
  };
  const lines = (value) =>
    value
      .split(/[\n,]/)
      .map((item) => item.trim())
      .filter(Boolean);

  function feedback(message, error = false) {
    $("feedback").textContent = message;
    $("feedback").className = `feedback${error ? " error" : ""}`;
    $("feedback").hidden = false;
  }

  async function request(path, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(path, {
        ...options,
        headers: { "Content-Type": "application/json", ...options.headers },
        signal: controller.signal,
        cache: "no-store",
      });
      const raw = await response.text();
      let data;
      try {
        data = raw ? JSON.parse(raw) : {};
      } catch {
        throw new Error("服务端返回了无法解析的内容，请检查本地服务。");
      }
      if (!response.ok || (data.ok === false && data.error)) {
        const problem =
          typeof data.error === "string"
            ? data.error
            : data.error?.message || data.message;
        throw new Error(problem || `请求失败（HTTP ${response.status}）`);
      }
      return data;
    } catch (error) {
      if (error.name === "AbortError")
        throw new Error("请求超时，操作结果尚未确认。请等待状态同步后再操作。");
      if (error instanceof TypeError)
        throw new Error("无法连接本地服务，请确认服务仍在运行。");
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  function populate(config) {
    const merged = { ...defaults, ...config };
    $("discoverySource").value = merged.discoverySource;
    $("feeStrategy").value = merged.feeStrategy;
    for (const field of [...decimalFields, ...integerFields])
      $(field).value = merged[field];
    for (const field of percentFields)
      $(field).value = Number(merged[field]) / 100;
    for (const field of arrayFields)
      $(field).value = (merged[field] || []).join("\n");
    const autoStart = /^0+$/.test(String(merged.startBlock));
    $("startBlockMode").value = autoStart ? "auto" : "manual";
    $("startBlock").value = autoStart ? "" : String(merged.startBlock);
    for (const input of form.querySelectorAll('input[name="allowedKinds"]'))
      input.checked = merged.allowedKinds.includes(input.value);
    savedConfig = merged;
    loaded = true;
    dirty = false;
    renderSaveState();
    updateSummary();
    renderModeSettings();
  }

  function inactiveField(id) {
    const api = $("discoverySource").value === "api";
    if (id === "allowedHooks" || id === "startBlockMode") return api;
    if (id === "startBlock")
      return api || $("startBlockMode").value !== "manual";
    return api && ["maxBuyTaxBps", "maxSellTaxBps"].includes(id);
  }

  function collect() {
    for (const input of form.querySelectorAll("input"))
      input.classList.add("was-validated");
    const fields = [...form.querySelectorAll("input, textarea, select")];
    const previousDisabled = fields.map((input) => input.disabled);
    fields.forEach((input) => {
      input.disabled = inactiveField(input.id);
    });
    const valid = form.reportValidity();
    fields.forEach((input, index) => {
      input.disabled = previousDisabled[index];
    });
    if (!valid) throw new Error("请检查输入范围，填写完整的买入参数。");
    const config = {
      unknownTaxPolicy: "reject",
      discoverySource: $("discoverySource").value,
      feeStrategy: $("feeStrategy").value,
      taxCheck: "off",
    };
    if (!["api", "chain"].includes(config.discoverySource))
      throw new Error("请选择项目发现方式。");
    if (!["fixed", "competitive"].includes(config.feeStrategy))
      throw new Error("请选择优先费策略。");
    for (const field of decimalFields) {
      const value = $(field).value.trim();
      const gas = ["maxFeeGwei", "priorityFeeGwei"].includes(field);
      if (
        !(gas ? /^\d{1,78}(?:\.\d{1,9})?$/ : /^\d{1,78}(?:\.\d{1,18})?$/).test(
          value,
        )
      )
        throw new Error(
          gas
            ? "Gas 单价最多保留 9 位小数，避免发生单位舍入。"
            : "金额和费用请使用普通小数格式，不使用科学计数法。",
        );
      if (value.length > 97)
        throw new Error("金额和费用请使用普通小数格式，不使用科学计数法。");
      config[field] = value;
    }
    for (const field of integerFields) {
      config[field] = Number($(field).value);
      if (!Number.isSafeInteger(config[field]))
        throw new Error("编号、时限和轮询间隔必须为整数。");
    }
    if (config.maxLaunchAgeSeconds < 12 || config.maxLaunchAgeSeconds > 300)
      throw new Error("最大发射时间差必须为 12 至 300 秒。");
    for (const field of percentFields)
      config[field] = inactiveField(field)
        ? (savedConfig?.[field] ?? defaults[field])
        : Math.round(Number($(field).value) * 100);
    for (const field of arrayFields)
      config[field] = inactiveField(field)
        ? (savedConfig?.[field] ?? defaults[field])
        : lines($(field).value);
    config.allowedKinds = [
      ...form.querySelectorAll('input[name="allowedKinds"]:checked'),
    ].map((input) => input.value);
    const manualStart =
      config.discoverySource === "chain" &&
      $("startBlockMode").value === "manual";
    config.startBlock = manualStart ? $("startBlock").value.trim() : "0";
    if (!config.allowedKinds.length)
      throw new Error("请至少选择一种允许的项目类型。");
    if (Number(config.priorityFeeGwei) > Number(config.maxFeeGwei))
      throw new Error("优先费不能高于最高 Gas 单价。");
    if (
      !/^\d{1,20}$/.test(config.startBlock) ||
      BigInt(config.startBlock) > 2n ** 64n - 1n ||
      (manualStart && BigInt(config.startBlock) === 0n)
    )
      throw new Error("手动起始区块必须是大于 0 的整数，或选择自动查找起点。");
    if (config.rpcHttpUrls.length > 5 || config.rpcWsUrls.length > 3)
      throw new Error("最多可以设置 5 个 HTTP RPC 和 3 个 WebSocket RPC。");
    if (config.allowedHooks.length > 128)
      throw new Error("Hook 白名单最多可以设置 128 个地址。");
    for (const hook of config.allowedHooks)
      if (!/^0x[0-9a-fA-F]{40}$/.test(hook))
        throw new Error(
          "Hook 地址必须是以 0x 开头、共 42 个字符的以太坊地址。",
        );
    for (const field of ["rpcHttpUrls", "rpcWsUrls"]) {
      for (const value of config[field]) {
        if (value.length > 2048)
          throw new Error("单个 RPC 地址不得超过 2048 个字符。");
        let url;
        try {
          url = new URL(value);
        } catch {
          throw new Error("RPC 地址格式无效，请填写完整的服务商地址。");
        }
        const protocols =
          field === "rpcHttpUrls" ? ["http:", "https:"] : ["ws:", "wss:"];
        if (!protocols.includes(url.protocol))
          throw new Error(
            field === "rpcHttpUrls"
              ? "HTTP RPC 应以 https:// 或 http:// 开头。"
              : "WebSocket RPC 应以 wss:// 或 ws:// 开头。",
          );
      }
    }
    return config;
  }

  function updateSummary() {
    const amount = $("buyAmountEth").value;
    const gas = $("maxGasEth").value;
    $("summary-buy").textContent = amount || "—";
    $("summary-gas").textContent = gas || "—";
    try {
      const toWei = (value) => {
        if (!/^\d+(?:\.\d{1,18})?$/.test(value))
          throw new Error("invalid amount");
        const [integer, fraction = ""] = value.split(".");
        return BigInt(integer) * 10n ** 18n + BigInt(fraction.padEnd(18, "0"));
      };
      const total = toWei(amount) + toWei(gas);
      const integer = total / 10n ** 18n;
      const fraction = (total % 10n ** 18n)
        .toString()
        .padStart(18, "0")
        .replace(/0+$/, "");
      $("summary-total").textContent =
        `${integer}${fraction ? `.${fraction}` : ""}`;
    } catch {
      $("summary-total").textContent = "—";
    }
  }

  function renderSaveState() {
    $("save-state").textContent = !loaded
      ? "正在读取配置…"
      : dirty
        ? "● 有未保存的修改"
        : "✓ 配置已与本地服务同步";
    $("save-state").className = dirty ? "dirty" : "";
  }

  function renderControls() {
    const locked = configurationLocked();
    $("save-button").disabled =
      busy || stopping || !loaded || !online || locked;
    $("check-button").disabled =
      busy || stopping || !loaded || !online || locked;
    $("live-button").disabled =
      busy ||
      stopping ||
      !loaded ||
      !online ||
      locked ||
      !$("live-consent").checked ||
      !liveApproval;
    $("stop-button").disabled =
      stopping || !online || (!pendingStart && !locked);
    $("wallet-reload-button").disabled =
      busy || stopping || !online || !latestStatus || locked;
    for (const input of form.querySelectorAll(
      "input:not(#live-consent), textarea, select",
    ))
      input.disabled = busy || stopping || locked || !loaded;
    $("live-consent").disabled =
      busy ||
      stopping ||
      locked ||
      !online ||
      !latestStatus?.wallet?.configured;
    renderModeSettings();
    form.classList.toggle("is-busy", busy);
  }

  function renderModeSettings() {
    const api = $("discoverySource").value === "api";
    const locked = busy || stopping || configurationLocked() || !loaded;
    const manual = !api && $("startBlockMode").value === "manual";
    $("hook-whitelist-field").hidden = api;
    $("chain-start-mode").hidden = api;
    $("chain-deployment-note").hidden = api;
    $("manual-start-block").hidden = !manual;
    $("startBlock").required = manual;
    for (const id of [
      "allowedHooks",
      "startBlockMode",
      "startBlock",
      "maxBuyTaxBps",
      "maxSellTaxBps",
    ])
      $(id).disabled = locked || inactiveField(id);
    $("tax-check-note").classList.toggle("tax-off", api);
    $("tax-check-symbol").textContent = api ? "!" : "i";
    $("tax-check-detail").textContent = api
      ? "买卖税率未检测（不进行买卖模拟），卖出能力未验证，以上阈值不生效。仍按金额、Gas、池报价滑点与其他链上校验执行。"
      : "链上合约监听模式使用已审核的固定税率证据。代币与 Hook 组合必须匹配审核资料，买入与卖出税率均须通过限制；未知或冲突证据拒绝。这不保证未来可卖出。";
    $("tax-buy-hint").textContent = api
      ? "API 模式未检测，税率阈值不生效"
      : "已审核的买入税率不得超过此值";
    $("tax-sell-hint").textContent = api
      ? "API 模式未检测，卖出能力未验证"
      : "已审核的卖出税率不得超过此值";
    $("target-title").textContent = api
      ? "启动后第一个\n符合条件的新主网币"
      : "第一个\n符合条件的项目";
    $("buy-target-detail").textContent = api
      ? "启动后第一个符合条件的新主网币，买入一次"
      : "第一个符合条件的项目，买入一次";
    $("discovery-detail").textContent = api
      ? "自动读取官方新主网代币、池和 Hook 信息并核对链上回执，无需手填发射合约、Hook 白名单或起始区块。可提前启动等待主网上线。"
      : "高级模式直接监听已核实的发射合约，需要部署资料、Hook 白名单及监控起点。";
    $("monitor-explanation").textContent = api
      ? "只处理启动后完成部署且未超过最大发射时间差的主网项目；延迟发现的旧项目会跳过。每次继续运行会保留已有记录。"
      : "启动时先核对历史；若符合条件的项目已经发射，会停止并提示已错过，不追买旧币。扫描进度会保存，更改筛选条件后会重新核对。";
    $("launch-feed-title").textContent = api ? "官方 API 发现" : "API 辅助发现";
    $("flow-discovery").textContent = api
      ? "官方 API 新主网项目 → 链上核对"
      : "监听发射合约；API 变化触发补扫";
    $("launch-feed-description").textContent = api
      ? "发现新主网项目后，核对发射时间、官方身份、池和链上回执。全部检查通过且已启动实盘后，可触发一次买入；不保证首买或成交。"
      : "与链上 WebSocket 并行发现。接口变化只触发链上补扫；买入仍需官方部署核验、链上事件与筛选通过。";
  }

  function setConnection(connected) {
    online = connected;
    const element = $("connection-status");
    element.replaceChildren();
    const dot = document.createElement("span");
    dot.className = `status-dot ${connected ? "good" : "bad"}`;
    const label = document.createElement("span");
    label.textContent = connected ? "本地服务已连接" : "本地服务离线";
    element.append(dot, label);
    if (!connected) {
      $("run-status").textContent = "状态未知";
      $("run-detail").textContent = "服务连接中断，无法确认当前运行状态";
      $("wallet-status").textContent = "状态未知";
      $("wallet-status").classList.remove("configured");
      $("wallet-detail").textContent = "本地服务离线，钱包状态暂时无法确认。";
      $("monitor-status").textContent = "状态未知";
      $("monitor-status-panel").dataset.status = "offline";
      $("monitor-detail").textContent =
        "本地服务离线，以下进度为上次同步结果。";
      $("launch-feed-status").textContent = "状态未知";
    }
    renderControls();
  }

  function renderMonitor(monitor) {
    const status = monitor?.status;
    const api =
      monitor?.source === "api-baseline" ||
      (!monitor?.source &&
        (latestStatus?.config?.discoverySource ||
          savedConfig?.discoverySource ||
          defaults.discoverySource) === "api");
    const stopped =
      latestStatus &&
      !latestStatus.running &&
      ["watching", "auditing", "baselining"].includes(status);
    $("monitor-status").textContent = stopped
      ? "已停止 · 保留进度"
      : monitorNames[status] || "等待同步";
    $("monitor-status-panel").dataset.status = stopped
      ? "stopped"
      : status || "pending";
    $("monitor-detail").textContent =
      monitor?.detail ||
      (api && status === "watching"
        ? "正在监听官方 API 新出现的主网项目，按已保存策略检查。"
        : monitorDetails[status]) ||
      "正在等待服务端返回监控进度。";
    if (stopped)
      $("monitor-detail").textContent =
        "监听已结束；下方保留最近一次运行的起点与进度。";
    $("monitor-start-label").textContent = api ? "监听开始于" : "起始区块";
    const baselineDate = dateFrom(monitor?.baselineAt);
    $("monitor-start").textContent = api
      ? baselineDate?.toLocaleString("zh-CN", { hour12: false }) || "尚未开始"
      : (monitor?.startBlock ?? "待确定");
    $("monitor-next-item").hidden = api;
    $("monitor-audit-item").hidden = api;
    $("monitor-source").textContent = monitorSources[monitor?.source] || "—";
    $("monitor-next").textContent = monitor?.nextBlock ?? "—";
    $("monitor-audit").textContent = monitor?.auditThroughBlock ?? "—";
  }

  function renderWallet(wallet) {
    const configured = Boolean(wallet?.configured && wallet?.address);
    $("wallet-status").textContent = wallet
      ? configured
        ? "已导入"
        : "未导入"
      : "未读取";
    $("wallet-status").classList.toggle("configured", configured);
    $("wallet-address").textContent = configured
      ? wallet.address
      : "尚未导入钱包";
    $("wallet-detail").textContent = configured
      ? "本地签名钱包已加载。核对公开地址，实盘启动后会使用此钱包执行买入。"
      : "实盘需要钱包。点击下方「导入或更换钱包」，按步骤在本机终端导入。";
  }

  function renderLaunchFeed(feed, running) {
    const date = dateFrom(feed?.checkedAt);
    const cache = feed?.cacheMaxAgeSeconds;
    $("launch-feed-status").textContent = !feed
      ? "未运行"
      : running
        ? date
          ? "已同步"
          : "等待首次读取"
        : date
          ? "已停止 · 留存记录"
          : "未运行";
    $("launch-feed-time").textContent = date
      ? `最近读取 · ${date.toLocaleTimeString("zh-CN", { hour12: false })}`
      : "最近读取 · 尚无记录";
    $("launch-feed-cache").textContent =
      Number.isFinite(cache) && cache >= 0
        ? `接口缓存 · ${cache} 秒`
        : "接口缓存 · 未读取";
  }

  function renderReadiness(readiness) {
    const container = $("readiness-list");
    container.replaceChildren();
    const checks = Array.isArray(readiness?.checks) ? readiness.checks : [];
    const passed = checks.filter((check) => check.ok).length;
    $("readiness-count").textContent = checks.length
      ? `${passed} / ${checks.length} 通过`
      : "待检查";
    if (!checks.length) {
      const empty = document.createElement("p");
      empty.className = "empty-copy";
      empty.textContent = "尚无校验结果，点击“检查实盘就绪状态”读取。";
      container.append(empty);
    }
    for (const check of checks) {
      const item = document.createElement("div");
      item.className = "readiness-item";
      const icon = document.createElement("span");
      icon.className = `check-state${check.ok ? " pass" : ""}`;
      icon.textContent = check.ok ? "✓" : "!";
      icon.setAttribute("aria-label", check.ok ? "通过" : "未通过");
      const content = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = checkNames[check.name] || check.name || "校验项目";
      const detail = document.createElement("p");
      detail.textContent =
        typeof check.detail === "string"
          ? check.detail
          : check.detail
            ? JSON.stringify(check.detail)
            : check.ok
              ? "已通过"
              : "未满足执行条件";
      content.append(name, detail);
      item.append(icon, content);
      container.append(item);
    }
    const ready = readiness?.ok === true;
    const api =
      (latestStatus?.config?.discoverySource ||
        savedConfig?.discoverySource ||
        defaults.discoverySource) === "api";
    document
      .querySelector(".deployment-banner")
      .classList.toggle("ready", ready);
    $("deployment-heading").textContent = ready
      ? "服务端实盘就绪检查已通过"
      : "实盘尚未就绪 · 请完成下方检查";
    $("deployment-detail").textContent = ready
      ? "当前配置满足服务端校验条件。真实买入需要勾选授权并启动实盘，所有交易仍需通过运行时检查。"
      : api
        ? "API 模式自动获取项目与池信息并核对链上回执，无需提供主网清单。请先配置执行钱包，通过下方检查后由你启动；没有新主网币时继续等待。"
        : "实盘需要官方主网地址、合约接口、RPC 与交易路径通过校验。下方检查列出当前未满足的条件。";
  }

  function dateFrom(value) {
    if (value == null) return null;
    const date = new Date(
      typeof value === "number" && value < 100000000000 ? value * 1000 : value,
    );
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function renderLogs(logs) {
    const list = Array.isArray(logs) ? logs : [];
    const signature = JSON.stringify(list);
    if (signature === logSignature) return;
    logSignature = signature;
    const recent = [...list].sort(
      (a, b) =>
        (dateFrom(b.time || b.timestamp)?.getTime() || 0) -
        (dateFrom(a.time || a.timestamp)?.getTime() || 0),
    );
    $("log-count").textContent = `${list.length} 条`;
    const latest = recent[0];
    $("last-event-time").textContent = latest
      ? dateFrom(latest.time || latest.timestamp)?.toLocaleTimeString("zh-CN", {
          hour12: false,
        }) || "—"
      : "—";
    $("last-event-detail").textContent = latest
      ? eventNames[latest.event] ||
        latest.event ||
        latest.message ||
        "收到服务端事件"
      : "尚未收到运行记录";
    const container = $("activity-list");
    container.replaceChildren();
    if (!list.length) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      const title = document.createElement("strong");
      title.textContent = "等待第一个信号";
      const description = document.createElement("p");
      description.textContent =
        "启动监听后，这里会显示实际发现的项目和筛选结果。";
      empty.append(title, description);
      container.append(empty);
      return;
    }
    for (const log of recent.slice(0, 100)) {
      const row = document.createElement("div");
      row.className = "log-row";
      const time = document.createElement("time");
      time.className = "log-time";
      const date = dateFrom(log.time || log.timestamp);
      time.textContent =
        date?.toLocaleTimeString("zh-CN", { hour12: false }) || "—";
      if (date) {
        time.dateTime = date.toISOString();
        time.title = date.toLocaleString("zh-CN");
      }
      const event = document.createElement("span");
      const name = String(log.event || log.level || "event");
      event.className = `log-event${/error|fail|reject/i.test(name) ? " error" : /confirm|success/i.test(name) ? " success" : ""}`;
      event.textContent = eventNames[name] || name;
      const detail = document.createElement("span");
      detail.className = "log-detail";
      const {
        time: omittedTime,
        timestamp,
        event: omittedEvent,
        ...rest
      } = log;
      detail.textContent =
        Object.keys(rest).length === 1 && typeof rest.message === "string"
          ? rest.message
          : Object.keys(rest).length
            ? JSON.stringify(rest)
            : "—";
      row.append(time, event, detail);
      container.append(row);
    }
  }

  function renderResearch(research) {
    const signature = JSON.stringify(research || {});
    if (signature === researchSignature) return;
    researchSignature = signature;
    const date = dateFrom(research?.checkedAt);
    $("research-time").textContent = date
      ? `读取于 ${date.toLocaleTimeString("zh-CN", { hour12: false })}${Number.isFinite(research?.cacheMaxAgeSeconds) && research.cacheMaxAgeSeconds >= 0 ? ` · 缓存 ${research.cacheMaxAgeSeconds} 秒` : ""}`
      : "等待接口同步";
    const launches = Array.isArray(research?.launches) ? research.launches : [];
    const container = $("research-list");
    container.replaceChildren();
    if (!launches.length) {
      const empty = document.createElement("p");
      empty.className = "empty-copy";
      empty.textContent = date
        ? "官方接口当前没有返回发射记录。"
        : "尚未读取发射记录。启动监听后会定期刷新。";
      container.append(empty);
      return;
    }
    const table = document.createElement("table");
    table.className = "research-table";
    const header = document.createElement("thead");
    const headerRow = document.createElement("tr");
    for (const title of ["发射编号", "网络", "类型", "接口状态", "代币地址"]) {
      const cell = document.createElement("th");
      cell.textContent = title;
      cell.scope = "col";
      headerRow.append(cell);
    }
    header.append(headerRow);
    const body = document.createElement("tbody");
    const kinds = {
      evm_project: "v4 项目池",
      custom_token: "v4 自定义代币",
      univ4_hook: "v4 Hook 项目",
    };
    for (const launch of launches.slice(0, 5)) {
      const row = document.createElement("tr");
      const values = [
        launch.launchNumber == null ? "—" : `#${launch.launchNumber}`,
        Number(launch.chainId) === 11155111
          ? "Sepolia 测试网"
          : Number(launch.chainId) === 1
            ? "Ethereum 主网 · 待核验"
            : `链 ID ${launch.chainId ?? "未知"}`,
        kinds[launch.kind] || launch.kind || "—",
        launch.status || "—",
        launch.token
          ? `${String(launch.token).slice(0, 8)}…${String(launch.token).slice(-6)}`
          : "尚无代币地址",
      ];
      values.forEach((value, index) => {
        const cell = document.createElement("td");
        if (index === 1) {
          const badge = document.createElement("span");
          badge.className = `network-label${Number(launch.chainId) === 1 ? " mainnet" : ""}`;
          badge.textContent = value;
          cell.append(badge);
        } else cell.textContent = value;
        if (index === 0) cell.className = "launch-number";
        if (index === 4) {
          cell.className = "token-address";
          cell.title = launch.token || "尚无代币地址";
        }
        row.append(cell);
      });
      body.append(row);
    }
    table.append(header, body);
    container.append(table);
  }

  function renderStatus(status) {
    if (
      liveApproval &&
      (String(status.wallet?.address || "").toLowerCase() !==
        liveApproval.walletAddress.toLowerCase() ||
        (status.config &&
          !sameConfig(status.config, liveApproval.observedConfig) &&
          !sameConfig(status.config, liveApproval.config)))
    ) {
      clearLiveApproval();
      feedback("服务端配置或执行钱包发生变化，请重新核对后确认实盘。", true);
    }
    latestStatus = status;
    if (
      status.config &&
      (!loaded || !dirty || configurationLocked()) &&
      !sameConfig(status.config, savedConfig)
    ) {
      const discardedDraft = dirty;
      populate(status.config);
      clearLiveApproval();
      if (discardedDraft)
        feedback("服务端任务已启动，页面已切换为实际运行配置。", true);
    }
    setConnection(true);
    const running = Boolean(status.running);
    const phase = status.state?.phase || "idle";
    const api =
      (status.config?.discoverySource ||
        savedConfig?.discoverySource ||
        defaults.discoverySource) === "api";
    const scanningPhase = [
      "observing",
      "watching",
      "auditing",
      "baselining",
    ].includes(phase);
    $("phase-label").textContent =
      !running && scanningPhase
        ? "监听已停止"
        : api && phase === "watching"
          ? "监听官方 API 新项目"
          : phaseNames[phase] || phase;
    const phaseDescription =
      status.state?.reason ||
      (!running && scanningPhase
        ? "上次监听已经停止，记录保留以供查看。"
        : status.state?.detail) ||
      (phase === "baselining"
        ? monitorDetails.baselining
        : phase === "auditing"
          ? monitorDetails.auditing
          : phase === "missed"
            ? monitorDetails.missed
            : "") ||
      (running
        ? "等待首个符合条件的新项目。"
        : "配置完成并通过检查后，可由你启动实盘。");
    const transactionDetail = status.state?.txHash
      ? `交易哈希 ${status.state.txHash}`
      : status.state?.token
        ? `目标代币 ${status.state.token}`
        : "";
    $("phase-detail").textContent = [phaseDescription, transactionDetail]
      .filter(Boolean)
      .join("\n");
    $("run-status").replaceChildren(
      document.createTextNode(
        phase === "missed"
          ? "已错过"
          : running
            ? phase === "auditing"
              ? "核对历史"
              : phase === "baselining"
                ? "准备监听"
                : "监听中"
            : "已停止",
      ),
    );
    const orbit = document.createElement("span");
    orbit.className = `status-orbit${running ? "" : " idle"}`;
    $("run-status").append(orbit);
    $("run-detail").textContent =
      phase === "missed"
        ? "启动前已有符合条件的项目，停止买入"
        : phase === "auditing" && running
          ? "检查历史记录，避免把旧币当作首发"
          : phase === "baselining" && running
            ? "记录现有项目，之后只处理新主网项目"
            : running
              ? status.mode === "live"
                ? "实盘运行中 · 满足条件后自动执行"
                : "运行模式与实盘不符，请先停止任务"
              : "完成钱包与参数配置后，勾选确认并启动实盘";
    $("mode-label").textContent =
      running && status.mode === "live" ? "实盘 · LIVE" : "实盘 · 待启动";
    $("mode-label").classList.toggle("live", running && status.mode === "live");
    const config = status.config || savedConfig;
    $("budget-value").textContent = config?.buyAmountEth ?? "—";
    $("gas-value").textContent = config?.maxGasEth ?? "—";
    renderReadiness(status.readiness);
    renderWallet(status.wallet);
    renderMonitor(status.monitor);
    renderLaunchFeed(status.launchFeed, running);
    renderLogs(status.logs);
    renderResearch(status.research);
    $("last-refresh").textContent =
      `同步于 ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`;
    renderControls();
  }

  async function syncStatus() {
    if (polling) return;
    polling = true;
    const generation = statusGeneration;
    try {
      const status = await request("/api/status");
      if (generation !== statusGeneration) return;
      renderStatus(status);
      if (!loaded && status.config) populate(status.config);
      renderControls();
    } catch {
      if (generation === statusGeneration) setConnection(false);
    } finally {
      polling = false;
    }
  }

  async function save(approvedConfig) {
    const config = approvedConfig || collect();
    const response = await request("/api/config", {
      method: "PUT",
      body: JSON.stringify(config),
    });
    populate(response.config || (response.buyAmountEth ? response : config));
    return response;
  }

  async function action(task) {
    if (busy || stopping) return;
    statusGeneration++;
    busy = true;
    renderControls();
    try {
      await task();
    } catch (error) {
      feedback(error.message, true);
    } finally {
      busy = false;
      await syncStatus();
      renderControls();
    }
  }

  form.addEventListener("input", (event) => {
    if (event.target.id === "live-consent") {
      try {
        approveLive();
      } catch (error) {
        clearLiveApproval();
        feedback(error.message, true);
      }
      renderControls();
      return;
    }
    dirty = true;
    clearLiveApproval();
    renderSaveState();
    updateSummary();
    renderControls();
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    action(async () => {
      await save();
      feedback("配置已保存到本地服务。");
    });
  });
  $("check-button").addEventListener("click", () =>
    action(async () => {
      await save();
      const result = await request("/api/check", {
        method: "POST",
        body: "{}",
      });
      const readiness = result.readiness || result;
      if (Array.isArray(readiness.checks)) renderReadiness(readiness);
      feedback(
        readiness.ok
          ? "就绪检查已通过。实盘启动后仍会校验每个候选项目。"
          : "检查已完成，当前仍有条件未满足。请查看“实盘就绪检查”。",
        !readiness.ok,
      );
    }),
  );
  $("wallet-reload-button").addEventListener("click", () =>
    action(async () => {
      clearLiveApproval();
      const wallet = await request("/api/wallet/reload", {
        method: "POST",
        body: "{}",
      });
      if (wallet.error) throw new Error(wallet.error);
      renderWallet(wallet);
      feedback(
        wallet.configured
          ? "钱包已重新加载，请核对显示的公开地址。"
          : "尚未检测到钱包，请先在本机终端运行导入命令。",
        !wallet.configured,
      );
    }),
  );
  $("live-button").addEventListener("click", () =>
    action(async () => {
      const approved = liveApproval;
      if (!$("live-consent").checked || !approved)
        throw new Error("启动实盘前，请先勾选真实交易授权。");
      if (!sameConfig(collect(), approved.config)) {
        clearLiveApproval();
        throw new Error("配置已变化，请重新核对金额和条件并确认实盘。");
      }
      const attempt = { cancelled: false };
      pendingStart = attempt;
      renderControls();
      try {
        const saved = await save(approved.config);
        if (attempt.cancelled) return;
        const acceptedConfig = saved.config || saved;
        if (!sameConfig(acceptedConfig, approved.config))
          throw new Error("服务端保存结果与确认的配置不一致，请重新核对。");
        const result = await request("/api/start", {
          method: "POST",
          body: JSON.stringify({
            mode: "live",
            expectedConfig: approved.config,
            expectedWalletAddress: approved.walletAddress,
          }),
        });
        if (attempt.cancelled) return;
        feedback(
          typeof result.message === "string"
            ? result.message
            : "实盘启动请求已完成，实际状态以服务端同步结果为准。",
        );
      } catch (error) {
        if (!attempt.cancelled) throw error;
      } finally {
        if (pendingStart === attempt) pendingStart = null;
        clearLiveApproval();
      }
    }),
  );
  $("stop-button").addEventListener("click", async () => {
    if (stopping) return;
    // A stop must remain available while the normal action queue is awaiting save/start.
    if (pendingStart) pendingStart.cancelled = true;
    stopping = true;
    statusGeneration++;
    clearLiveApproval();
    renderControls();
    try {
      const result = await request("/api/stop", { method: "POST", body: "{}" });
      feedback(
        typeof result.message === "string"
          ? result.message
          : "停止请求已完成，请查看服务端运行状态。已广播的交易不会被撤销。",
      );
    } catch (error) {
      feedback(error.message, true);
    } finally {
      stopping = false;
      await syncStatus();
      renderControls();
    }
  });

  for (const link of document.querySelectorAll(".nav-item"))
    link.addEventListener("click", () => {
      for (const other of document.querySelectorAll(".nav-item"))
        other.classList.toggle("active", other === link);
    });
  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "1") {
      event.preventDefault();
      $("overview").scrollIntoView({ behavior: "smooth" });
    }
  });

  async function initialize() {
    renderControls();
    try {
      const config = await request("/api/config");
      populate(config.config || config);
    } catch (error) {
      feedback(error.message, true);
    }
    await syncStatus();
    async function poll() {
      if (!busy) await syncStatus();
      pollTimer = setTimeout(poll, 2000);
    }
    pollTimer = setTimeout(poll, 2000);
  }
  window.addEventListener("pagehide", () => clearTimeout(pollTimer));
  initialize();
})();
