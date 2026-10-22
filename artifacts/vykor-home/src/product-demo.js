// A small, local-only product interface. The surrounding page owns its motion.
let nextDemoId = 0;

const paths = {
  pen: '<path d="M12 20H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7"/><path d="m16 3 5 5-9 9-5 1 1-5 8-8Z"/>',
  note: '<path d="M16 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10l6-6V5a2 2 0 0 0-2-2h-3Z"/><path d="M15 21v-6h6M7 8h10M7 12h5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  folder: '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>',
  chat: '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>',
  terminal: '<path d="m5 7 4 5-4 5M13 17h6"/><rect x="2" y="3" width="20" height="18" rx="3"/>',
  browser: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a18 18 0 0 1 0 18 18 18 0 0 1 0-18Z"/>',
  arrow: '<path d="M12 19V5m-6 6 6-6 6 6"/>',
  link: '<path d="M15 3h6v6m0-6-9 9"/><path d="M11 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6"/>',
  branch: '<circle cx="6" cy="5" r="3"/><circle cx="6" cy="19" r="3"/><circle cx="18" cy="6" r="3"/><path d="M6 8v8m0-4h6a6 6 0 0 0 6-3"/>',
  shield: '<path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z"/><path d="m9 12 2 2 4-4"/>',
};

function icon(name, className = '') {
  return `<svg class="pd-icon ${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.file}</svg>`;
}

function mark(className = '') {
  return `<svg class="pd-mark ${className}" viewBox="0 0 40 36" fill="currentColor" aria-hidden="true"><path d="M12 3H7L2 8v20l5 5h5v-5H9l-2-2V10l2-2h3zm16 0h5l5 5v20l-5 5h-5v-5h3l2-2V10l-2-2h-3z"/><rect x="13" y="11" width="14" height="14" rx="4"/><path d="M17.5 16v4m5-4v4" stroke="var(--pd-background)" stroke-width="2.5" stroke-linecap="round"/></svg>`;
}

const examples = {
  interface: {
    title: '界面演示',
    prompt: '为新产品做一个安静、清晰的发布页。',
    response: '先确定首屏：一句话说明产品，再展示真正的工作界面。',
    detail: '对话留在中间，项目放在左边。需要的文件和终端，就在手边。',
  },
  copy: {
    title: '梳理首屏文案',
    prompt: '第一句话，怎样让人知道 Vykor 能做什么？',
    response: '从正在做的事出发：把想法、对话和项目放到一起。',
    detail: '先说清用途，再让工作界面承接这句话。',
  },
  keyboard: {
    title: '检查键盘操作',
    prompt: '把不依赖鼠标的操作，也考虑进去。',
    response: '用 Tab 移动焦点，方向键切换工具标签。输入框保留换行与中文输入。',
    detail: '这里的输入只保留为页面草稿，不会发起模型请求。',
  },
};

const codeLines = [
  '<span class="pd-code-keyword">import</span> { Workspace } <span class="pd-code-keyword">from</span> <span class="pd-code-string">"./Workspace"</span>;',
  '',
  '<span class="pd-code-keyword">export default function</span> <span class="pd-code-function">LaunchPage</span>() {',
  '  <span class="pd-code-keyword">return</span> (',
  '    &lt;<span class="pd-code-tag">main</span> <span class="pd-code-attr">className</span>=<span class="pd-code-string">"launch"</span>&gt;',
  '      &lt;<span class="pd-code-tag">header</span>&gt;',
  '        &lt;<span class="pd-code-tag">p</span>&gt;你的 AI 工作台&lt;/<span class="pd-code-tag">p</span>&gt;',
  '        &lt;<span class="pd-code-tag">h1</span>&gt;Vykor&lt;/<span class="pd-code-tag">h1</span>&gt;',
  '      &lt;/<span class="pd-code-tag">header</span>&gt;',
  '      &lt;<span class="pd-code-function">Workspace</span> /&gt;',
  '    &lt;/<span class="pd-code-tag">main</span>&gt;',
  '  );',
  '}',
];

/**
 * Mount independent app surfaces in their final window coordinates.
 * No network, model, filesystem, or terminal requests are made by this demo.
 */
export function mountProductDemo(container) {
  if (!container || typeof container.append !== 'function') {
    throw new TypeError('mountProductDemo needs a DOM container.');
  }

  const id = `vykor-demo-${++nextDemoId}`;
  const machine = document.createElement('div');
  machine.className = 'product-machine';
  machine.dataset.ui = '';
  machine.dataset.assembled = 'false';
  machine.dataset.mode = 'files';
  machine.setAttribute('role', 'group');
  machine.setAttribute('aria-label', 'Vykor 产品界面演示，使用示例内容');
  machine.innerHTML = `
    <div class="product-part pd-shell" data-part="shell" data-ui aria-hidden="true"></div>

    <header class="product-part pd-chrome" data-part="chrome" data-ui>
      <div class="pd-brand">${mark()}<span>Vykor</span></div>
      <div class="pd-window-title"><span>产品发布页</span><span class="pd-title-divider">/</span><span data-demo-title>界面演示</span></div>
      <div class="pd-window-controls" aria-hidden="true"><i></i><i></i><i></i></div>
    </header>

    <aside class="product-part pd-sidebar" data-part="sidebar" data-ui aria-label="项目和会话">
      <nav class="pd-nav" aria-label="演示导航">
        <button type="button" class="pd-nav-row" data-nav="new">${icon('pen')}<span>新对话</span></button>
        <button type="button" class="pd-nav-row" data-nav="notes">${icon('note')}<span>便笺</span></button>
        <button type="button" class="pd-nav-row" data-nav="scheduled">${icon('clock')}<span>定时任务</span></button>
      </nav>
      <div class="pd-project-section">
        <p class="pd-section-label">项目</p>
        <button type="button" class="pd-project-row" aria-expanded="true" aria-controls="${id}-tasks" data-project-toggle>${icon('chevron', 'pd-project-chevron')}${icon('folder')}<span>产品发布页</span></button>
        <div class="pd-task-list" id="${id}-tasks" aria-label="产品发布页中的会话">
          ${Object.entries(examples).map(([key, sample]) => `<button type="button" class="pd-task-row${key === 'interface' ? ' is-selected' : ''}" data-task="${key}" aria-current="${key === 'interface' ? 'page' : 'false'}">${icon('chat')}<span>${sample.title}</span></button>`).join('')}
        </div>
      </div>
      <div class="pd-sidebar-bottom"><span class="pd-avatar" aria-hidden="true">V</span><span class="pd-local-label">本地工作区<small>界面演示</small></span></div>
    </aside>

    <section class="product-part pd-conversation" data-part="conversation" data-ui aria-label="示例对话">
      <header class="pd-conversation-header"><span data-demo-title>界面演示</span><span class="pd-sample-label">示例对话</span></header>
      <div class="pd-messages" tabindex="0" role="region" aria-label="对话内容">
        <div class="pd-example-thread">
          <article class="pd-message pd-user-message"><p class="pd-message-label">你</p><p data-prompt>${examples.interface.prompt}</p></article>
          <article class="pd-message pd-assistant-message"><p class="pd-message-label">${mark()}<span>Vykor</span></p><p data-response>${examples.interface.response}</p><p class="pd-message-detail" data-detail>${examples.interface.detail}</p><div class="pd-context-file">${icon('file')}<span>LaunchPage.tsx</span></div></article>
        </div>
        <div class="pd-nav-content" hidden><p data-nav-heading></p><p data-nav-description></p></div>
      </div>
    </section>

    <section class="product-part pd-composer" data-part="composer" data-ui aria-label="演示输入区">
      <form class="pd-composer-form">
        <label class="pd-sr-only" for="${id}-draft">写下想继续的工作，仅保留在当前演示页面</label>
        <textarea id="${id}-draft" class="pd-draft" rows="2" spellcheck="false" placeholder="写下想继续的工作…">让工作界面，成为首页的一部分。</textarea>
        <div class="pd-composer-toolbar"><span class="pd-composer-context">${icon('folder')}<span>产品发布页</span></span><span class="pd-local-mode">本地草稿</span><button class="pd-save-draft" type="submit" aria-label="保留演示草稿" title="保留演示草稿">${icon('arrow')}</button></div>
      </form>
      <p class="pd-draft-status" role="status" aria-live="polite">Enter 保留草稿<span class="pd-keyboard-hint"> · Shift + Enter 换行</span></p>
    </section>

    <section class="product-part pd-tools" data-part="tools" data-ui aria-label="文件和工具">
      <div class="pd-tool-tabs" role="tablist" aria-label="工具">
        ${[['files', 'folder', '文件'], ['terminal', 'terminal', '终端'], ['browser', 'browser', '浏览器']].map(([key, glyph, label]) => `<button type="button" class="pd-tool-tab${key === 'files' ? ' is-selected' : ''}" id="${id}-tab-${key}" role="tab" aria-selected="${key === 'files'}" aria-controls="${id}-panel-${key}" tabindex="${key === 'files' ? 0 : -1}" data-tool="${key}">${icon(glyph)}<span>${label}</span></button>`).join('')}
      </div>
      <div class="pd-tool-panel pd-files-panel" id="${id}-panel-files" role="tabpanel" aria-labelledby="${id}-tab-files" data-panel="files" tabindex="0">
        <div class="pd-file-tab">${icon('file')}<span>LaunchPage.tsx</span><span class="pd-code-sample-label">代码示例</span></div>
        <p class="pd-breadcrumb">src <span>/</span> pages <span>/</span> LaunchPage.tsx</p>
        <div class="pd-code-scroll"><pre class="pd-code"><code>${codeLines.map((line, index) => `<span class="pd-code-line"><span class="pd-line-number" aria-hidden="true">${index + 1}</span><span>${line || ' '}</span></span>`).join('')}</code></pre></div>
        <div class="pd-inline-terminal"><div class="pd-terminal-heading">${icon('terminal')}<span>终端</span><span class="pd-terminal-example-label">命令示例</span></div><pre><span class="pd-terminal-prompt" aria-hidden="true">›</span> npm run dev</pre><p>仅展示命令，不会执行。</p></div>
      </div>
      <div class="pd-tool-panel pd-terminal-panel" id="${id}-panel-terminal" role="tabpanel" aria-labelledby="${id}-tab-terminal" data-panel="terminal" tabindex="0" hidden>
        <div class="pd-terminal-heading">${icon('terminal')}<span>终端</span><span class="pd-terminal-example-label">命令示例</span></div>
        <p class="pd-tool-description">开发与构建时，命令就在项目旁边。</p>
        <pre class="pd-terminal-code"><span class="pd-code-comment"># 启动开发服务</span>\nnpm run dev\n\n<span class="pd-code-comment"># 构建发布文件</span>\nnpm run build</pre>
        <p class="pd-terminal-note">此处是命令示例，页面不会执行命令。</p>
      </div>
      <div class="pd-tool-panel pd-browser-panel" id="${id}-panel-browser" role="tabpanel" aria-labelledby="${id}-tab-browser" data-panel="browser" tabindex="0" hidden>
        <div class="pd-browser-address">${icon('browser')}<span>github.com/rzx007/Vykor</span></div>
        <div class="pd-browser-content">${mark()}<h3>继续了解 Vykor</h3><p>查看项目源码、使用说明和发布版本。</p><a class="pd-browser-link" href="https://github.com/rzx007/Vykor" target="_blank" rel="noopener noreferrer">打开项目源码 ${icon('link')}</a><p class="pd-browser-note">链接会在新标签页打开。</p></div>
      </div>
      <footer class="pd-tools-status">${icon('branch')}<span>main</span><span class="pd-status-context">产品发布页</span></footer>
    </section>
  `;
  container.append(machine);

  const controller = new AbortController();
  const { signal } = controller;
  const parts = Object.fromEntries([...machine.querySelectorAll('[data-part]')].map((part) => [part.dataset.part, part]));
  const textarea = machine.querySelector('.pd-draft');
  const submit = machine.querySelector('.pd-save-draft');
  const status = machine.querySelector('.pd-draft-status');
  const tabs = [...machine.querySelectorAll('[data-tool]')];
  const tasks = [...machine.querySelectorAll('[data-task]')];
  const thread = machine.querySelector('.pd-example-thread');
  const navContent = machine.querySelector('.pd-nav-content');
  let assembled = false;
  let destroyed = false;
  let localDraft = textarea.value;

  function updateSubmit() {
    submit.disabled = !assembled || !textarea.value.trim();
  }

  function setAssembled(value) {
    if (destroyed) return;
    assembled = Boolean(value);
    if (!assembled && machine.contains(document.activeElement)) document.activeElement.blur();
    machine.inert = !assembled;
    machine.dataset.assembled = String(assembled);
    machine.setAttribute('aria-disabled', String(!assembled));
    machine.querySelectorAll('button, textarea').forEach((control) => { control.disabled = !assembled; });
    updateSubmit();
  }

  function setMode(mode) {
    if (destroyed) return;
    const aliases = { workspace: 'files', coding: 'files', research: 'browser', document: 'files', file: 'files', '文件': 'files', '终端': 'terminal', '浏览器': 'browser' };
    const nextMode = aliases[mode] || mode;
    if (!['files', 'terminal', 'browser'].includes(nextMode)) return;
    machine.dataset.mode = nextMode;
    tabs.forEach((tab) => {
      const selected = tab.dataset.tool === nextMode;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      tab.classList.toggle('is-selected', selected);
    });
    machine.querySelectorAll('[data-panel]').forEach((panel) => { panel.hidden = panel.dataset.panel !== nextMode; });
  }

  function setTitle(title) {
    machine.querySelectorAll('[data-demo-title]').forEach((node) => { node.textContent = title; });
  }

  function selectTask(key) {
    const sample = examples[key];
    if (!sample) return;
    tasks.forEach((task) => {
      const selected = task.dataset.task === key;
      task.classList.toggle('is-selected', selected);
      task.setAttribute('aria-current', selected ? 'page' : 'false');
    });
    machine.querySelectorAll('[data-nav]').forEach((button) => button.classList.remove('is-selected'));
    setTitle(sample.title);
    thread.hidden = false;
    navContent.hidden = true;
    machine.querySelector('[data-prompt]').textContent = sample.prompt;
    machine.querySelector('[data-response]').textContent = sample.response;
    machine.querySelector('[data-detail]').textContent = sample.detail;
  }

  machine.addEventListener('click', (event) => {
    if (!assembled || destroyed) return;
    const target = event.target.closest('button');
    if (!target || !machine.contains(target)) return;
    if (target.dataset.tool) setMode(target.dataset.tool);
    if (target.dataset.task) selectTask(target.dataset.task);
    if (target.hasAttribute('data-project-toggle')) {
      const expanded = target.getAttribute('aria-expanded') !== 'true';
      target.setAttribute('aria-expanded', String(expanded));
      machine.querySelector('.pd-task-list').hidden = !expanded;
    }
    if (target.dataset.nav) {
      const views = {
        new: ['新对话', '接下来，想做什么？', '把想法写在下方，试着保留一份页面草稿。'],
        notes: ['便笺', '发布页笔记', '首屏留给品牌。工作界面跟随滚动逐步展开。'],
        scheduled: ['定时任务', '还没有演示任务', '这个界面演示没有创建或运行定时任务。'],
      };
      const [title, heading, description] = views[target.dataset.nav];
      setTitle(title);
      thread.hidden = true;
      navContent.hidden = false;
      machine.querySelector('[data-nav-heading]').textContent = heading;
      machine.querySelector('[data-nav-description]').textContent = description;
      machine.querySelectorAll('[data-nav], [data-task]').forEach((row) => {
        row.classList.toggle('is-selected', row === target);
        if (row.dataset.task) row.setAttribute('aria-current', 'false');
      });
      if (target.dataset.nav === 'new') textarea.focus({ preventScroll: true });
    }
  }, { signal });

  machine.querySelector('.pd-tool-tabs').addEventListener('keydown', (event) => {
    if (!assembled || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const current = tabs.indexOf(document.activeElement);
    if (current < 0) return;
    event.preventDefault();
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    setMode(tabs[index].dataset.tool);
    tabs[index].focus({ preventScroll: true });
  }, { signal });

  function saveDraft(event) {
    event?.preventDefault();
    if (!assembled || destroyed || !textarea.value.trim()) return;
    localDraft = textarea.value;
    status.textContent = '演示草稿已保留在当前页面，不会发送模型请求。';
    status.dataset.saved = 'true';
    textarea.focus({ preventScroll: true });
  }

  machine.querySelector('form').addEventListener('submit', saveDraft, { signal });
  textarea.addEventListener('input', () => {
    updateSubmit();
    if (status.dataset.saved === 'true' && textarea.value !== localDraft) {
      status.textContent = '草稿有修改 · Enter 保留';
      delete status.dataset.saved;
    }
  }, { signal });
  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) saveDraft(event);
  }, { signal });

  setAssembled(false);
  return {
    machine,
    parts,
    controls: { tabs, textarea, submit, status },
    setAssembled,
    setMode,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      controller.abort();
      machine.remove();
    },
  };
}
