/**
 * 图片工坊的控制台面板（浏览器侧 bundle）。
 *
 * 宿主按 `/assets/extensions/<包>/<版本>/dist/webui.js` 取这个文件，
 * 直接 `import()` 它的 default 导出；所以它是纯浏览器 ES 模块：
 * 不 import 任何东西（`cortico/*` 在这里只允许 `import type`），只用 ctx.ui。
 */

const STYLE = `
.iw-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 12px; margin-top: 10px; }
.iw-card { border: 1px solid rgba(128,128,128,.35); border-radius: 10px; overflow: hidden; display: flex; flex-direction: column; }
.iw-card.iw-hit { outline: 2px solid #4aa8ff; outline-offset: 2px; }
.iw-thumb { width: 100%; aspect-ratio: 1 / 1; object-fit: cover; background: rgba(128,128,128,.12); display: block; }
.iw-meta { padding: 6px 8px 8px; display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
.iw-name { font-weight: 600; word-break: break-all; }
.iw-sub { opacity: .65; font-size: 11px; word-break: break-all; }
.iw-row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin-top: 2px; }
.iw-empty { grid-column: 1 / -1; padding: 22px 8px; text-align: center; opacity: .8; }
.iw-conn { display: flex; gap: 6px; align-items: center; }
.iw-big img { max-width: 100%; max-height: 68vh; display: block; margin: 0 auto; }
.iw-bigmeta { font-size: 12px; opacity: .7; margin: 8px 0; word-break: break-all; }
.iw-prompt { font-size: 12px; white-space: pre-wrap; word-break: break-word; }
`;

const ZH = {
  galleryTitle: '作品',
  galleryEn: 'Pictures',
  galleryDesc: '桌宠画过的图。点缩略图看大图；复制路径就能交给别的渠道转发。',
  statusTitle: '状态',
  statusEn: 'Status',
  statusDesc: '图片接口、密钥与磁盘占用。改完即用，不必重启。',
  refresh: '刷新',
  openFolder: '打开文件夹',
  openFolderBad: '打不开文件夹',
  selfTest: '插入自检样图',
  selfTestDone: '自检样图已写入：落盘 → 索引 → 取图 → 显示，这条路是通的。',
  selfTestBad: '自检失败',
  clearAll: '清空作品',
  clearAsk: '清空所有作品？',
  clearBody: '索引和磁盘上的图片都会被删掉，不能撤销。',
  cleared: '清空完成',
  remove: '删除',
  removeAsk: '删掉这张图？',
  removeBody: '文件会从磁盘上删除。',
  removed: '已删除',
  big: '看大图',
  copyPath: '复制路径',
  copyId: '复制编号',
  copyDir: '复制目录',
  count: '作品',
  bytes: '占用',
  shown: '本页显示',
  connecting: '实时推送未连接',
  connected: '实时推送中',
  busier: '处理中…',
  empty: '还没有作品。让桌宠画一张，或者点「插入自检样图」看看链路通不通。',
  keyField: '图片接口密钥',
  keyHint: '密钥只写进部署的 .env，不进 config.json。',
  keyPlaceholder: '粘贴 API key 后保存',
  keyPlaceholderSet: '已配置；粘贴新的可以覆盖',
  keyEmpty: '先粘贴密钥',
  keySaved: '密钥已保存',
  keyCleared: '密钥已清除',
  clearKey: '清除密钥',
  clearKeyBody: '会把 .env 里那一行置空。之后画图会直接失败，直到重新填入。',
  saveKey: '保存密钥',
  chainTitle: '模型链',
  chainDesc: '按顺序试的一串后端：本地 ComfyUI 与云端 OpenAI 兼容接口可以放进同一个 JSON 数组，数组顺序就是优先级。前一档连不上、超时、额度用完、模型没装，就自动换下一档。留空则用下面那套单档配置。',
  chainPlaceholder: '[{"name":"local","preset":"comfyui","baseUrl":"http://127.0.0.1:8188","ckpt":"sd_xl_base_1.0.safetensors"}]',
  chainSave: '保存模型链',
  chainSaved: '模型链已保存',
  chainBad: '模型链存不上',
  chainTest: '测试模型链',
  chainTesting: '正在探活…',
  chainTestNone: '还没测试。点「测试模型链」挨个试一下。',
  chainEmpty: '没有配模型链（用的是下面那套单档配置）',
  endpoint: '接口地址',
  model: '模型',
  params: '默认参数',
  dir: '目录',
  timeout: '单次超时',
  keyName: '密钥变量名',
  keyState: '密钥',
  keyFrom: '密钥来源',
  fromBot: '部署 .env',
  fromProvider: '端点 .env',
  setLabel: '已填',
  unsetLabel: '未填',
  indexFile: '索引文件',
  keep: '保留张数',
  lastItem: '最近一张',
  lastError: '最近错误',
  none: '无',
  runtime: '运行时',
  unknown: '未知',
  loadBad: '读不到作品列表',
  patchTitle: 'QQ 发图路径',
  patchDesc: '旧版 QQ 扩展（qqbot）的 qq_send_image / qq_view_image 只按扩展目录解析本地路径；这里把它们改成先按桌宠工作区解析、扩展目录兜底。第三方包升级会把改动覆写掉，所以每次启动都重打一遍；打不上会显示在这里。切到官方 QQ 扩展（qq）后它按 blob 句柄发图，这两处自动跳过、不碰文件。',
  patchWhere: '安装目录',
  patchCount: '补丁',
  patchAt: '上次检查',
  patchLastRestart: '上次重启请求',
  patchAllDone: '处都在',
  patchNone: '没有要打补丁的 QQ 扩展',
  patchPending: '刚补上，重启后生效',
  patchMissing: '有没打上的',
  patchNoApp: '没找到安装目录',
  patchUnchecked: '没检查过',
  patchApplied: '这次补了',
  patchStuck: '上一轮已经为同一处请求过重启，这次仍然缺——先别再重启，看看文件是不是只读。',
  patchRepatch: '重打补丁',
  patchRestore: '还原备份',
  patchRestoreAsk: '按备份还原补丁？',
  patchRestoreBody: '用更新下发的原文（.coopanion-orig）覆盖回 QQ 扩展的 world.ts，QQ 发图改回只认扩展目录里的相对路径（重启控制台后生效）。备份不会删，随时能再打回来。',
  patchRestoreDone: '已按备份还原',
  patchRestoreNone: '没动：文件本来就是原文',
  patchRestoreBad: '还原出错',
  patchRestored: '已还原',
  patchRestoredAt: '上次还原',
  patchBackup: '备份',
  patchBackupNone: '没有备份',
  patchBackupSame: '与当前一致',
  patchRestart: '重启控制台',
  patchRestartAsk: '现在重启控制台？',
  patchRestartBody: '控制台会自己重启（几秒钟），正在跑的对话会断。QQ 扩展的补丁要重启才装载。',
  patchRestartSent: '重启请求已发出，稍等几秒',
  patchRestartBad: '重启请求没送到',
  patchRepatched: '又对了一遍',
  patchRepatchedBad: '对补丁时出错',
};

const EN = {
  galleryTitle: 'Pictures',
  galleryEn: '',
  galleryDesc: 'Everything the pet has drawn. Click a thumbnail to enlarge; copy the path to hand it to another channel.',
  statusTitle: 'Status',
  statusEn: '',
  statusDesc: 'Image endpoint, API key and disk usage. Changes apply immediately.',
  refresh: 'Refresh',
  openFolder: 'Open folder',
  openFolderBad: 'Could not open the folder',
  selfTest: 'Insert self-test image',
  selfTestDone: 'Self-test image written: save → index → fetch → display all work.',
  selfTestBad: 'Self-test failed',
  clearAll: 'Clear all',
  clearAsk: 'Clear every picture?',
  clearBody: 'Both the index and the files on disk are removed. This cannot be undone.',
  cleared: 'Cleared',
  remove: 'Delete',
  removeAsk: 'Delete this picture?',
  removeBody: 'The file is removed from disk.',
  removed: 'Deleted',
  big: 'Enlarge',
  copyPath: 'Copy path',
  copyId: 'Copy id',
  copyDir: 'Copy folder',
  count: 'Pictures',
  bytes: 'On disk',
  shown: 'Shown',
  connecting: 'Live feed disconnected',
  connected: 'Live feed connected',
  busier: 'Working…',
  empty: 'No pictures yet. Ask the pet to draw one, or use "Insert self-test image" to check the chain.',
  keyField: 'Image API key',
  keyHint: 'The key is written to the deployment .env, never to config.json.',
  keyPlaceholder: 'Paste the API key, then save',
  keyPlaceholderSet: 'Configured; paste a new one to replace it',
  keyEmpty: 'Paste the key first',
  keySaved: 'Key saved',
  keyCleared: 'Key cleared',
  clearKey: 'Clear key',
  clearKeyBody: 'Empties that line in .env. Drawing will fail until a key is entered again.',
  saveKey: 'Save key',
  chainTitle: 'Model chain',
  chainDesc: 'Backends tried in order: a local ComfyUI and OpenAI-compatible cloud endpoints can share one JSON array, and the array order is the priority. If one is unreachable, times out, runs out of quota or lacks the model, the next entry is tried. Empty means the single-backend settings below.',
  chainPlaceholder: '[{"name":"local","preset":"comfyui","baseUrl":"http://127.0.0.1:8188","ckpt":"sd_xl_base_1.0.safetensors"}]',
  chainSave: 'Save chain',
  chainSaved: 'Model chain saved',
  chainBad: 'Could not save the model chain',
  chainTest: 'Test chain',
  chainTesting: 'Probing…',
  chainTestNone: 'Not tested yet. Press "Test chain" to try each entry.',
  chainEmpty: 'No model chain configured (the single-backend settings below are used)',
  endpoint: 'Endpoint',
  model: 'Model',
  params: 'Defaults',
  dir: 'Folder',
  timeout: 'Timeout',
  keyName: 'Secret name',
  keyState: 'API key',
  keyFrom: 'Key source',
  fromBot: 'deployment .env',
  fromProvider: 'endpoint .env',
  setLabel: 'set',
  unsetLabel: 'missing',
  indexFile: 'Index file',
  keep: 'Keep',
  lastItem: 'Latest',
  lastError: 'Last error',
  none: 'none',
  runtime: 'Runtime',
  unknown: 'unknown',
  loadBad: 'Could not read the picture list',
  patchTitle: 'QQ Image Paths',
  patchDesc: 'The legacy QQ extension (qqbot) resolves local picture paths against its own folder; these two patches make qq_send_image / qq_view_image try your pet workspace first. The updater overwrites them, so they are re-applied on every start; anything that fails shows up here. With the official QQ extension (qq) pictures travel as blob handles, so both patches are skipped and no file is touched.',
  patchWhere: 'Install dir',
  patchCount: 'Patches',
  patchAt: 'Checked',
  patchLastRestart: 'Last restart request',
  patchAllDone: 'in place',
  patchNone: 'no QQ extension needs patching',
  patchPending: 'applied, takes effect after restart',
  patchMissing: 'some are missing',
  patchNoApp: 'install directory not found',
  patchUnchecked: 'not checked yet',
  patchApplied: 'applied now',
  patchStuck: 'A restart was already requested for these and they are still missing — stop restarting and check whether the files are read-only.',
  patchRepatch: 'Re-apply',
  patchRestore: 'Restore from backup',
  patchRestoreAsk: 'Restore the patches from backup?',
  patchRestoreBody: 'Overwrites the QQ extension world.ts with the updater-shipped original (.coopanion-orig); QQ images fall back to extension-relative paths after a console restart. Backups are kept, so you can re-apply any time.',
  patchRestoreDone: 'Restored from backup',
  patchRestoreNone: 'Nothing changed: files were already pristine',
  patchRestoreBad: 'Restore failed',
  patchRestored: 'restored',
  patchRestoredAt: 'Last restore',
  patchBackup: 'Backup',
  patchBackupNone: 'no backup',
  patchBackupSame: 'same as current file',
  patchRestart: 'Restart console',
  patchRestartAsk: 'Restart the console now?',
  patchRestartBody: 'The console restarts by itself (a few seconds); a running conversation is cut off. The QQ patch only loads on restart.',
  patchRestartSent: 'Restart requested, give it a few seconds',
  patchRestartBad: 'Restart request did not go through',
  patchRepatched: 'Checked again',
  patchRepatchedBad: 'Patch check failed',
};

const text = (language) => (language === 'en' ? EN : ZH);

/** 异常一律收敛成一行字。 */
function message(err) {
  if (err && typeof err === 'object' && 'message' in err) return String(err.message);
  return String(err);
}

/** 模型链文本框：能解析就按两格缩进排好，解析不了就原样显示（让用户自己改）。 */
function prettyChain(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function injectStyle(ctx) {
  const el = ctx.ui.h('style');
  el.textContent = STYLE;
  ctx.root.appendChild(el);
}

/** 缩略图与原图共用一份 object URL 缓存，卸载时统一撤销。 */
function makeUrlCache(ctx) {
  const urls = new Map();
  const forId = (id) => {
    const hit = urls.get(id);
    if (hit) return Promise.resolve(hit);
    return ctx.invokeBinary('blob', [id]).then((blob) => {
      const url = URL.createObjectURL(blob);
      urls.set(id, url);
      ctx.own({ dispose: () => { URL.revokeObjectURL(url); } });
      return url;
    });
  };
  const forget = (id) => {
    const url = urls.get(id);
    if (!url) return;
    urls.delete(id);
    try {
      URL.revokeObjectURL(url);
    } catch {
      /* 撤销过就算了 */
    }
  };
  const forgetAll = () => {
    for (const id of [...urls.keys()]) forget(id);
  };
  return { forId, forget, forgetAll };
}

// ---------------------------------------------------------------------------
// 作品页
// ---------------------------------------------------------------------------

function galleryPanel(ctx) {
  const tx = text(ctx.language);
  injectStyle(ctx);

  const sheet = ctx.ui.sheet({ title: tx.galleryTitle, en: tx.galleryEn || undefined, desc: tx.galleryDesc });
  ctx.root.appendChild(sheet.el);
  const body = sheet.body;

  const stats = ctx.ui.statgrid();
  body.appendChild(stats);

  const rowbar = ctx.ui.rowbar();
  const connBox = ctx.ui.h('div', 'iw-conn');
  rowbar.appendChild(connBox);
  rowbar.appendChild(ctx.ui.h('span', 'grow'));
  body.appendChild(rowbar);

  const actions = ctx.ui.actions();
  body.appendChild(actions);

  const note = ctx.ui.msgline('');
  body.appendChild(note);

  const grid = ctx.ui.h('div', 'iw-grid');
  body.appendChild(grid);

  const urls = makeUrlCache(ctx);
  let focusId = '';
  let lastCount = -1;
  let seq = 0;

  const setConn = (label, tone) => {
    connBox.textContent = '';
    connBox.appendChild(ctx.ui.pill(label, tone));
  };
  const say = (line) => {
    note.textContent = line || '';
  };

  const render = (data) => {
    const items = Array.isArray(data?.items) ? data.items : [];
    lastCount = typeof data?.count === 'number' ? data.count : items.length;
    stats.replaceChildren(
      ctx.ui.stat({ k: tx.count, v: String(lastCount) }),
      ctx.ui.stat({ k: tx.bytes, v: ctx.ui.fmt.bytes(data?.totalBytes ?? 0) }),
      ctx.ui.stat({ k: tx.shown, v: String(items.length) }),
    );
    grid.replaceChildren();
    if (!items.length) {
      grid.appendChild(ctx.ui.h('div', 'iw-empty', tx.empty));
      return;
    }
    for (const item of items) grid.appendChild(card(item));
    if (focusId) {
      const hit = grid.querySelector(`[data-id="${focusId}"]`);
      if (hit) {
        hit.classList.add('iw-hit');
        hit.scrollIntoView({ block: 'nearest' });
      }
      focusId = '';
    }
  };

  const card = (item) => {
    const el = ctx.ui.h('div', 'iw-card');
    el.dataset.id = item.id;

    const img = ctx.ui.h('img', 'iw-thumb');
    img.alt = item.note || item.prompt || item.id;
    img.loading = 'lazy';
    el.appendChild(img);
    urls.forId(item.id)
      .then((url) => {
        if (!ctx.signal.aborted) img.src = url;
      })
      .catch(() => {
        img.alt = `${tx.loadBad}: ${item.id}`;
      });

    const meta = ctx.ui.h('div', 'iw-meta');
    meta.appendChild(ctx.ui.h('div', 'iw-name', item.note || item.file));
    meta.appendChild(ctx.ui.h('div', 'iw-sub', `${item.id} · ${item.size || '?'} · ${ctx.ui.fmt.bytes(item.bytes)}`));
    meta.appendChild(ctx.ui.h('div', 'iw-sub', ctx.ui.fmt.clock(item.createdAt)));

    const bar = ctx.ui.h('div', 'iw-row');
    bar.append(
      ctx.ui.button(tx.big, { size: 'sm', onClick: () => openBig(item) }),
      ctx.ui.copyButton(item.path, { label: tx.copyPath }),
      ctx.ui.button(tx.remove, { variant: 'danger', size: 'sm', onClick: () => { void drop(item); } }),
    );
    meta.appendChild(bar);
    el.appendChild(meta);
    return el;
  };

  const openBig = (item) => {
    const wrap = ctx.ui.h('div', 'iw-big');
    const img = ctx.ui.h('img');
    img.alt = item.note || item.id;
    wrap.appendChild(img);
    wrap.appendChild(ctx.ui.h('div', 'iw-bigmeta', `${item.file} · ${item.size || '?'} · ${ctx.ui.fmt.bytes(item.bytes)} · ${item.model || tx.unknown}`));
    if (item.prompt) wrap.appendChild(ctx.ui.h('pre', 'iw-prompt', item.prompt));
    const bar = ctx.ui.actions();
    bar.append(
      ctx.ui.copyButton(item.path, { label: tx.copyPath }),
      ctx.ui.copyButton(item.id, { label: tx.copyId }),
    );
    wrap.appendChild(bar);
    ctx.ui.drawer(item.note || item.id, wrap);
    urls.forId(item.id)
      .then((url) => {
        if (!ctx.signal.aborted) img.src = url;
      })
      .catch((err) => ctx.ui.toast(message(err), 'bad'));
  };

  const reload = async (busy) => {
    const mine = ++seq;
    const release = busy ? ctx.ui.busy(tx.busier, tx.refresh) : null;
    try {
      const data = await ctx.invoke('list', [120]);
      if (mine !== seq || ctx.signal.aborted) return;
      render(data);
      say('');
    } catch (err) {
      if (mine !== seq) return;
      say(`${tx.loadBad}：${message(err)}`);
      ctx.ui.toast(`${tx.loadBad}：${message(err)}`, 'bad');
    } finally {
      if (release) release.dispose();
    }
  };

  const drop = async (item) => {
    const ok = await ctx.ui.confirm({ title: tx.removeAsk, body: `${tx.removeBody}\n${item.file}`, danger: true });
    if (!ok) return;
    try {
      await ctx.invoke('remove', [item.id]);
      urls.forget(item.id);
      await reload(false);
      ctx.ui.toast(tx.removed, 'ok');
    } catch (err) {
      ctx.ui.toast(message(err), 'bad');
    }
  };

  const clearAll = async () => {
    const ok = await ctx.ui.confirm({ title: tx.clearAsk, body: tx.clearBody, danger: true });
    if (!ok) return;
    try {
      await ctx.invoke('clear', []);
      urls.forgetAll();
      await reload(false);
      ctx.ui.toast(tx.cleared, 'ok');
    } catch (err) {
      ctx.ui.toast(message(err), 'bad');
    }
  };

  const openFolder = async () => {
    try {
      const res = await ctx.invoke('openFolder', []);
      if (!res?.ok) ctx.ui.toast(res?.detail || tx.openFolderBad, 'bad');
    } catch (err) {
      ctx.ui.toast(message(err), 'bad');
    }
  };

  const selfTest = async () => {
    const release = ctx.ui.busy(tx.busier, tx.selfTest);
    try {
      const res = await ctx.invoke('selftest', []);
      if (res?.item?.id) focusId = res.item.id;
      await reload(false);
      ctx.ui.toast(tx.selfTestDone, 'ok');
    } catch (err) {
      ctx.ui.toast(`${tx.selfTestBad}：${message(err)}`, 'bad');
    } finally {
      release.dispose();
    }
  };

  actions.append(
    ctx.ui.button(tx.refresh, { size: 'sm', onClick: () => { void reload(true); } }),
    ctx.ui.button(tx.openFolder, { size: 'sm', onClick: () => { void openFolder(); } }),
    ctx.ui.button(tx.selfTest, { size: 'sm', onClick: () => { void selfTest(); } }),
    ctx.ui.button(tx.clearAll, { variant: 'danger', size: 'sm', onClick: () => { void clearAll(); } }),
  );

  setConn(tx.connecting, 'plain');
  ctx.own(ctx.stream({
    open: () => setConn(tx.connected, 'on'),
    close: () => setConn(tx.connecting, 'off'),
    message: (raw) => {
      let frame = null;
      try {
        frame = JSON.parse(raw);
      } catch {
        return;
      }
      if (!frame || typeof frame !== 'object') return;
      switch (frame.t) {
        case 'ready':
          setConn(`${tx.connected} · ${frame.count ?? 0}`, 'on');
          break;
        case 'item':
          if (frame.item?.id) focusId = frame.item.id;
          void reload(false);
          break;
        case 'focus':
          if (frame.id) focusId = frame.id;
          void reload(false);
          break;
        case 'removed':
          if (frame.id) urls.forget(frame.id);
          void reload(false);
          break;
        case 'cleared':
          urls.forgetAll();
          void reload(false);
          break;
        case 'error':
          ctx.ui.toast(frame.message || tx.unknown, 'bad');
          break;
        default:
          break;
      }
    },
  }));

  // 推送关掉时页面也能自己追上：只在张数变了以后重建。
  ctx.interval(() => {
    ctx.invoke('list', [1])
      .then((data) => {
        if (typeof data?.count === 'number' && data.count !== lastCount) void reload(false);
      })
      .catch(() => { /* 面板自己会显示错误，这里别刷屏 */ });
  }, 30000);

  void reload(true);
}

// ---------------------------------------------------------------------------
// 状态页
// ---------------------------------------------------------------------------

function statusPanel(ctx) {
  const tx = text(ctx.language);
  injectStyle(ctx);

  const sheet = ctx.ui.sheet({ title: tx.statusTitle, en: tx.statusEn || undefined, desc: tx.statusDesc });
  ctx.root.appendChild(sheet.el);
  const body = sheet.body;

  const stats = ctx.ui.statgrid();
  body.appendChild(stats);

  const keyCard = ctx.ui.section(tx.keyField, tx.keyHint);
  const keyRow = ctx.ui.actions();
  const keyInput = ctx.ui.input({ type: 'password', placeholder: tx.keyPlaceholder, cls: 'mono' });
  keyRow.append(
    ctx.ui.field(tx.keyField, keyInput),
    ctx.ui.button(tx.saveKey, { variant: 'primary', size: 'sm', onClick: () => { void saveKey(); } }),
    ctx.ui.button(tx.clearKey, { size: 'sm', onClick: () => { void clearKey(); } }),
  );
  keyCard.appendChild(keyRow);
  body.appendChild(keyCard);

  const chainCard = ctx.ui.section(tx.chainTitle, tx.chainDesc);
  const chainInput = ctx.ui.textarea({ rows: 6, cls: 'mono', placeholder: tx.chainPlaceholder });
  chainInput.dataset.dirty = '0';
  chainInput.addEventListener('input', () => { chainInput.dataset.dirty = '1'; });
  chainCard.appendChild(ctx.ui.field(tx.chainTitle, chainInput));
  const chainRow = ctx.ui.actions();
  const chainList = ctx.ui.h('div', 'iw-sub', tx.chainTestNone);
  chainRow.append(
    ctx.ui.button(tx.chainSave, { size: 'sm', variant: 'primary', onClick: () => { void saveChain(); } }),
    ctx.ui.button(tx.chainTest, { size: 'sm', onClick: () => { void testChain(); } }),
  );
  chainCard.appendChild(chainRow);
  chainCard.appendChild(chainList);
  body.appendChild(chainCard);

  const patchCard = ctx.ui.section(tx.patchTitle, tx.patchDesc);
  const patchHead = ctx.ui.h('div', 'iw-conn');
  patchCard.appendChild(patchHead);
  const patchKv = ctx.ui.h('div');
  patchCard.appendChild(patchKv);
  const patchLines = ctx.ui.h('div');
  patchCard.appendChild(patchLines);
  const patchBar = ctx.ui.actions();
  patchBar.append(
    ctx.ui.button(tx.patchRepatch, { size: 'sm', onClick: () => { void repatch(); } }),
    ctx.ui.button(tx.patchRestore, { size: 'sm', onClick: () => { void restorePatches(); } }),
    ctx.ui.button(tx.patchRestart, { size: 'sm', onClick: () => { void restartConsole(); } }),
  );
  patchCard.appendChild(patchBar);
  body.appendChild(patchCard);

  const kvBox = ctx.ui.h('div');
  body.appendChild(kvBox);

  const actions = ctx.ui.actions();
  body.appendChild(actions);

  const note = ctx.ui.msgline('');
  body.appendChild(note);

  let currentDir = '';

  /** QQ 发图路径补丁：2 处都在？这次补了几处？备份还在吗？要不要重启？ */
  const renderPatch = (p) => {
    const total = Number(p?.total ?? 0);
    const done = Number(p?.done ?? 0);
    const patched = Array.isArray(p?.patched) ? p.patched : [];
    const failed = Array.isArray(p?.failed) ? p.failed : [];
    const pending = Boolean(p?.restartPending);
    const restored = Array.isArray(p?.restored?.restored) ? p.restored.restored : [];
    const backups = Array.isArray(p?.backups) ? p.backups : [];
    const label = p?.error
      ? `${tx.patchNoApp}：${p.error}`
      : failed.length
        ? `${tx.patchMissing}（${failed.length}）`
        : !p?.at
          ? tx.patchUnchecked
          : restored.length
            ? tx.patchRestored
            : (pending ? tx.patchPending : (total === 0 ? tx.patchNone : `${done}/${total} ${tx.patchAllDone}`));
    const tone = p?.error || failed.length || restored.length ? 'off' : 'on';
    patchHead.replaceChildren(ctx.ui.pill(label, tone));
    if (patched.length) patchHead.appendChild(ctx.ui.pill(`${tx.patchApplied} ${patched.length}`, 'on'));
    const fileOf = (path) => String(path || '').split(/[\\/]/).pop();
    const backupText = backups.length
      ? backups.map((b) => `${fileOf(b.file)}：${b.hasBackup ? (b.same ? tx.patchBackupSame : `${b.backupBytes}B`) : tx.patchBackupNone}`).join(' · ')
      : tx.none;
    patchKv.replaceChildren(ctx.ui.kv([
      { k: tx.patchWhere, v: ctx.ui.h('span', 'mono', String(p?.appRoot || '—')) },
      { k: tx.patchCount, v: total === 0 ? (tx.patchNone) : `${done}/${total}` },
      { k: tx.patchAt, v: p?.at ? ctx.ui.fmt.clock(p.at) : tx.none },
      { k: tx.patchBackup, v: ctx.ui.h('span', 'mono', backupText) },
      ...(restored.length
        ? [{ k: tx.patchRestoredAt, v: `${restored.length} · ${p?.restored?.at ? ctx.ui.fmt.clock(p.restored.at) : ''}` }]
        : []),
      {
        k: tx.patchLastRestart,
        v: p?.restart
          ? `${p.restart.detail || p.restart.status || '—'} · ${p.restart.at ? ctx.ui.fmt.clock(p.restart.at) : ''}`
          : tx.none,
      },
    ]));
    patchLines.replaceChildren();
    for (const f of failed) patchLines.appendChild(ctx.ui.h('div', 'iw-sub', `${f.id} — ${f.error || f.what || ''}`));
    for (const b of backups) {
      if (!b.hasBackup) patchLines.appendChild(ctx.ui.h('div', 'iw-sub', `${b.id} — ${tx.patchBackupNone}`));
    }
    if (p?.stuck) patchLines.appendChild(ctx.ui.h('div', 'iw-sub', tx.patchStuck));
  };

  const render = (s) => {
    currentDir = String(s?.dir ?? '');
    stats.replaceChildren(
      ctx.ui.stat({ k: tx.count, v: String(s?.count ?? 0) }),
      ctx.ui.stat({ k: tx.bytes, v: ctx.ui.fmt.bytes(s?.totalBytes ?? 0) }),
      ctx.ui.stat({ k: tx.keyState, v: ctx.ui.pill(s?.keySet ? tx.setLabel : tx.unsetLabel, s?.keySet ? 'on' : 'off') }),
      ctx.ui.stat({ k: tx.model, v: String(s?.model || '—') }),
    );
    kvBox.replaceChildren(ctx.ui.kv([
      { k: tx.endpoint, v: s?.baseUrl || '—' },
      { k: tx.params, v: `${s?.size || '—'} · ${s?.quality || '—'} · ${s?.format || '—'}` },
      { k: tx.timeout, v: ctx.ui.fmt.duration(s?.timeoutMs ?? 0) },
      { k: tx.keyName, v: ctx.ui.h('span', 'mono', s?.keyName || '') },
      {
        k: tx.keyFrom,
        v: s?.keyFrom === 'bot'
          ? tx.fromBot
          : s?.keyFrom === 'provider'
            ? tx.fromProvider + (s?.keyProvider ? ` · ${s.keyProvider}` : '')
            : tx.none,
      },
      { k: tx.dir, v: ctx.ui.h('span', 'mono', currentDir) },
      { k: tx.indexFile, v: ctx.ui.h('span', 'mono', s?.indexFile || '') },
      { k: tx.keep, v: String(s?.keep ?? 0) },
      { k: tx.lastItem, v: s?.lastItemAt ? ctx.ui.fmt.clock(s.lastItemAt) : tx.none },
      { k: tx.lastError, v: s?.lastError || tx.none },
      { k: tx.runtime, v: `Node ${s?.node ?? '?'} · ${s?.platform ?? '?'}` },
    ]));
    keyInput.placeholder = s?.keySet ? tx.keyPlaceholderSet : tx.keyPlaceholder;
    if (String(chainInput.dataset.dirty) !== '1') chainInput.value = prettyChain(s?.models);
    chainList.replaceChildren();
    const chain = Array.isArray(s?.chain) ? s.chain : [];
    if (!chain.length) {
      chainList.textContent = tx.chainEmpty;
    } else {
      for (const it of chain) {
        const extra = it.model || it.baseUrl || '';
        const line = ctx.ui.h('div', 'iw-sub');
        line.appendChild(ctx.ui.pill(it.ok ? tx.setLabel : tx.unsetLabel, it.ok ? 'on' : 'off'));
        line.appendChild(ctx.ui.h('span', null, ` ${it.name} · ${it.preset}${extra ? ` · ${extra}` : ''}${it.ok ? '' : ` — ${it.reason}`}`));
        chainList.appendChild(line);
      }
    }
    renderPatch(s?.patch);
  };

  const load = async (busy) => {
    const release = busy ? ctx.ui.busy(tx.busier, tx.statusTitle) : null;
    try {
      const s = await ctx.invoke('state', []);
      if (ctx.signal.aborted) return;
      render(s);
    } catch (err) {
      note.textContent = message(err);
      ctx.ui.toast(message(err), 'bad');
    } finally {
      if (release) release.dispose();
    }
  };

  const saveChain = async () => {
    const value = chainInput.value.trim();
    const release = ctx.ui.busy(tx.busier, tx.chainSave);
    try {
      await ctx.setConfig('world:image', { 'worlds.image.models': value });
      chainInput.dataset.dirty = '0';
      note.textContent = tx.chainSaved;
      ctx.ui.toast(tx.chainSaved, 'ok');
      await load(false);
    } catch (err) {
      note.textContent = `${tx.chainBad}：${message(err)}`;
      ctx.ui.toast(`${tx.chainBad}：${message(err)}`, 'bad');
    } finally {
      release.dispose();
    }
  };

  const testChain = async () => {
    const release = ctx.ui.busy(tx.chainTesting, tx.chainTest);
    try {
      const res = await ctx.invoke('probe', []);
      chainList.replaceChildren();
      if (res?.error) {
        chainList.appendChild(ctx.ui.h('div', 'iw-sub', res.error));
        return;
      }
      const items = Array.isArray(res?.items) ? res.items : [];
      if (!items.length) {
        chainList.textContent = tx.chainEmpty;
        return;
      }
      for (const it of items) {
        const line = ctx.ui.h('div', 'iw-sub');
        line.appendChild(ctx.ui.pill(it.ok ? tx.setLabel : tx.unsetLabel, it.ok ? 'on' : 'off'));
        line.appendChild(ctx.ui.h('span', null, ` ${it.name} · ${it.preset} — ${it.detail}`));
        chainList.appendChild(line);
      }
    } catch (err) {
      ctx.ui.toast(message(err), 'bad');
    } finally {
      release.dispose();
    }
  };

  const saveKey = async () => {
    const value = keyInput.value.trim();
    if (!value) {
      ctx.ui.toast(tx.keyEmpty, 'bad');
      return;
    }
    const release = ctx.ui.busy(tx.busier, tx.saveKey);
    try {
      const s = await ctx.invoke('setKey', [value]);
      keyInput.value = '';
      render(s);
      note.textContent = tx.keySaved;
      ctx.ui.toast(tx.keySaved, 'ok');
    } catch (err) {
      ctx.ui.toast(message(err), 'bad');
    } finally {
      release.dispose();
    }
  };

  const clearKey = async () => {
    const ok = await ctx.ui.confirm({ title: tx.clearKey, body: tx.clearKeyBody, danger: true });
    if (!ok) return;
    try {
      const s = await ctx.invoke('clearKey', []);
      render(s);
      note.textContent = tx.keyCleared;
      ctx.ui.toast(tx.keyCleared, 'ok');
    } catch (err) {
      ctx.ui.toast(message(err), 'bad');
    }
  };

  const repatch = async () => {
    const release = ctx.ui.busy(tx.busier, tx.patchRepatch);
    try {
      const p = await ctx.invoke('repatch', []);
      renderPatch(p);
      const bad = p?.error || (p?.failed?.length ? `${p.failed.length} 处没打上` : '');
      if (bad) ctx.ui.toast(`${tx.patchRepatchedBad}：${bad}`, 'bad');
      else if (p?.restartPending) ctx.ui.toast(tx.patchPending, 'ok');
      else ctx.ui.toast(tx.patchRepatched, 'ok');
    } catch (err) {
      ctx.ui.toast(`${tx.patchRepatchedBad}：${message(err)}`, 'bad');
    } finally {
      release.dispose();
    }
  };

  const restorePatches = async () => {
    const ok = await ctx.ui.confirm({ title: tx.patchRestoreAsk, body: tx.patchRestoreBody, danger: true });
    if (!ok) return;
    const release = ctx.ui.busy(tx.busier, tx.patchRestore);
    try {
      const p = await ctx.invoke('restore', []);
      renderPatch(p);
      const bad = p?.error || (p?.restored?.failed?.length ? `${p.restored.failed.length} 处没还原` : '');
      if (bad) ctx.ui.toast(`${tx.patchRestoreBad}：${bad}`, 'bad');
      else if (p?.restored?.restored?.length) ctx.ui.toast(tx.patchRestoreDone, 'ok');
      else ctx.ui.toast(tx.patchRestoreNone, 'ok');
      await load(false);
    } catch (err) {
      ctx.ui.toast(`${tx.patchRestoreBad}：${message(err)}`, 'bad');
    } finally {
      release.dispose();
    }
  };

  const restartConsole = async () => {
    const ok = await ctx.ui.confirm({ title: tx.patchRestartAsk, body: tx.patchRestartBody });
    if (!ok) return;
    try {
      const p = await ctx.invoke('restart', []);
      const sent = Boolean(p?.restart?.ok);
      renderPatch(p);
      ctx.ui.toast(sent ? tx.patchRestartSent : `${tx.patchRestartBad}：${p?.restart?.detail || p?.restart?.status || ''}`, sent ? 'ok' : 'bad');
    } catch (err) {
      ctx.ui.toast(`${tx.patchRestartBad}：${message(err)}`, 'bad');
    }
  };

  const selfTest = async () => {
    const release = ctx.ui.busy(tx.busier, tx.selfTest);
    try {
      await ctx.invoke('selftest', []);
      await load(false);
      ctx.ui.toast(tx.selfTestDone, 'ok');
    } catch (err) {
      ctx.ui.toast(`${tx.selfTestBad}：${message(err)}`, 'bad');
    } finally {
      release.dispose();
    }
  };

  actions.append(
    ctx.ui.button(tx.refresh, { size: 'sm', onClick: () => { void load(true); } }),
    ctx.ui.button(tx.selfTest, { size: 'sm', onClick: () => { void selfTest(); } }),
    ctx.ui.copyButton(() => currentDir, { label: tx.copyDir }),
  );

  void load(true);
}

export default {
  panels: {
    gallery: { mount: galleryPanel },
    status: { mount: statusPanel },
  },
};
