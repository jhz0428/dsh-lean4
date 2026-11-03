// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// 构建产物的冒烟测试：把 lib/client.js 当成浏览器里的那份东西执行一遍。
//
// 它不渲染真正编辑器（那需要一个真 DOM），但要证明四件事：
//   1) bundle 能在「只有 window/document」的环境里被求值，不会炸在 CodeMirror 的
//      模块初始化上；
//   2) 它走的是 ModuleLoader 协议（`window.__ModuleLoader__.load`），id 正确；
//   3) 工厂返回的插件形状对（name / inject / apply）；
//   4) apply 注册的 descriptor 与本包的契约一致——后缀、优先级、fetchStrategy，
//      以及「超大文件」那条分支真的会走到提示而不是去挂载编辑器。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

let passed = 0;
const failures = [];

function check(name, run) {
	try {
		run();
		passed += 1;
	} catch (error) {
		failures.push(`${name}: ${error.message}`);
	}
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
	const a = JSON.stringify(actual);
	const b = JSON.stringify(expected);
	if (a !== b) throw new Error(`${message}\n  实际: ${a}\n  期望: ${b}`);
}

/** 只够让 `insertStyle` 与 CodeMirror 的模块级探测过关的最小 document。 */
function fakeDocument() {
	const head = { children: [], appendChild(node) { this.children.push(node); } };
	return {
		baseURI: 'http://localhost/',
		head,
		getElementById: (id) => head.children.find((node) => node.id === id) ?? null,
		createElement: (tag) => ({ tag, id: '', textContent: '' }),
		createTextNode: (text) => ({ text }),
		documentElement: { style: {} },
		body: { appendChild() {} }
	};
}

/** React 替身：hooks 只要能跑通「不挂编辑器」的那条渲染路径即可。 */
function fakeReact() {
	return {
		createElement(type, props, ...children) {
			return { type, props: props ?? {}, children };
		},
		useRef(initial) {
			return { current: initial ?? null };
		},
		useState(initial) {
			return [initial, () => {}];
		},
		useEffect() {},
		useCallback(fn) {
			return fn;
		},
		useMemo(fn) {
			return fn();
		}
	};
}

/** 在隔离上下文里跑 bundle，返回 ModuleLoader 收到的 spec。 */
function loadBundle() {
	const source = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8');
	const document = fakeDocument();
	let captured = null;
	const context = {
		document,
		navigator: { userAgent: 'node' },
		console,
		setTimeout,
		clearTimeout,
		URL,
		URLSearchParams,
		TextEncoder,
		TextDecoder,
		AbortController,
		fetch: () => Promise.reject(new Error('offline')),
		window: {
			document,
			navigator: { userAgent: 'node' },
			__ModuleLoader__: {
				load(spec) {
					captured = spec;
				}
			}
		}
	};
	context.globalThis = context;
	vm.createContext(context);
	vm.runInContext(source, context, { filename: 'client.js' });
	if (captured === null) throw new Error('bundle 没有调用 window.__ModuleLoader__.load');
	return { spec: captured, context };
}

check('bundle 走 ModuleLoader 协议且 id 正确', () => {
	const { spec } = loadBundle();
	assertEqual(spec.id, 'dsh-lean4', 'bundle id');
	assert(typeof spec.factory === 'function', 'factory 应是函数');
});

check('工厂返回 cordis 插件形状', () => {
	const { spec } = loadBundle();
	const plugin = spec.factory((name) => {
		if (name === 'react') return fakeReact();
		throw new Error(`意外的 require：${name}`);
	});
	assertEqual(plugin.name, 'dsh-lean4', '插件名');
	assertEqual(plugin.inject, ['betterSidebar'], 'inject 只依赖 betterSidebar');
	assert(typeof plugin.apply === 'function', 'apply 应是函数');
});

check('apply 注册的 descriptor 符合契约', () => {
	const { spec } = loadBundle();
	const plugin = spec.factory(() => fakeReact());
	const registered = [];
	let effects = 0;
	const ctx = {
		betterSidebar: {
			registerFileViewer(descriptor) {
				registered.push(descriptor);
				return () => {};
			}
		},
		effect(fn) {
			effects += 1;
			fn();
		}
	};
	plugin.apply(ctx);
	assertEqual(effects, 1, '注册必须包在 ctx.effect 里（否则 HMR 后重复注册会抛）');
	assertEqual(registered.length, 1, '应注册一个 viewer');
	const descriptor = registered[0];
	assertEqual(descriptor.id, 'lean-editor:lean', 'viewer id');
	assertEqual(descriptor.exts, ['lean'], '认领的后缀');
	assertEqual(descriptor.priority, 10, '必须高于内置 code 的 -100');
	assertEqual(descriptor.fetchStrategy, 'fsRead', '读文本走 fsRead');
	assert(typeof descriptor.component === 'function', 'component 应是函数');
	assertEqual(descriptor.title(), 'Lean 编辑器', '设置清单里的名字');
});

check('没有 betterSidebar 服务时静默跳过而不是抛错', () => {
	const { spec } = loadBundle();
	const plugin = spec.factory(() => fakeReact());
	let warned = 0;
	const original = console.warn;
	console.warn = () => {
		warned += 1;
	};
	try {
		plugin.apply({ effect() {} });
	} finally {
		console.warn = original;
	}
	assertEqual(warned, 1, '应打一条警告');
});

check('超大文件走提示分支，不去挂载编辑器', () => {
	const { spec } = loadBundle();
	const plugin = spec.factory(() => fakeReact());
	const registered = [];
	plugin.apply({
		betterSidebar: { registerFileViewer: (descriptor) => { registered.push(descriptor); return () => {}; } },
		effect(fn) {
			fn();
		}
	});
	const View = registered[0].component;
	const tree = View({
		ctx: {},
		scope: { sessionId: 's-1' },
		path: '/w/big.lean',
		content: undefined,
		largeFile: { size: 12 * 1024 * 1024 }
	});
	assertEqual(tree.props.className, 'dle-host', '外层容器');
	const notice = tree.children[0];
	assertEqual(notice.props.className, 'dle-notice', '提示块');
	assert(notice.children[0].includes('12.0 MiB'), `提示里应带体积，实际：${notice.children[0]}`);
});

// 惰性 vendor 的缓存必须和返回值分离：曾经把哨兵值 `globalThis` 当缓存返回，
// 第二次调用（React effect 双跑）就报「infoview 模块缺少 renderInfoview」。
check('惰性 vendor 缓存与返回值分离', () => {
	const code = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8');
	assert(code.includes('ensureInfoviewBundleCache !== undefined'), '应该有独立的缓存变量');
	assert(code.includes('ensureInfoviewBundleCache = null;'), '求值前先占 null，避免重复求值');
	assert(!code.includes('ensureInfoviewBundleOnce = globalThis'), '不能把哨兵值当返回值缓存');
});

// StateEffect.define() 返回的是 StateEffectType 实例而不是函数，必须 `.of(value)`；
// 写成 `setLines(lines)` 会静默失败，表现是「有 leanTags 却一个 ✓✓ 都没有」。
check('状态效果走 .of()', () => {
	const code = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8');
	assert(code.includes('setLines.of('), '目标已完成的标记效果必须用 .of() 派发');
	assert(code.includes("typeof marks.setLines?.of !== 'function'"), '派发前要检查 .of 是否存在');
});

// 官方 infoview 求值时会注册 `vscode-*` 自定义元素；同一份 bundle 求值两次就撞
// 「the name "vscode-badge" has already been used with this registry」，面板整块挂掉。
check('自定义元素重复注册被容忍', () => {
	const code = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8');
	assert(code.includes('has already been used with this registry'), '应吞掉「元素已注册」这一种错');
	assert(code.includes('CUSTOM_ELEMENTS_SHIM'), '同一个 registry 只包一次');
	// 已经加载好的那份优先，避免模块重建后又求值一遍 vendor。
	assert(
		code.indexOf('globalThis.__DCH_INFOVIEW__') < code.indexOf('typeof ensureInfoviewBundle === '),
		'应先认已加载的 __DCH_INFOVIEW__，再考虑求值'
	);
});

// `toCmDiagnostics` 会把 `isSilent: true` 的诊断剔掉，而「目标已完成」的
// `leanTags: [2]` 诊断恰好全是 silent —— 如果对勾从过滤后的列表取行号，
// 它永远拿到空数组，表现就是「方块没了，对勾也不出现」。
check('对勾取的是未过滤的原始诊断', () => {
	const code = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8');
	assert(code.includes('onDiagnosticsRaw'), '客户端要订阅原始诊断通道');
	assert(
		code.indexOf('onDiagnosticsRaw') > -1 && !/onDiagnostics:\s*\(list\)/.test(code),
		'不能再用过滤后的 onDiagnostics 取行号'
	);
	assert(code.includes('hooks.onDiagnosticsRaw?.(Array.isArray(list) ? list : [])'), '原始列表要在过滤前送出');
});

// 块注释渲染出来的 div 是 .cm-content 的直接子节点，CodeMirror 用
// getBoundingClientRect().height 量它——margin 不在 rect 里，会被漏算。
// 每块少算 marginTop+marginBottom，累积起来就是「渲染块与行号错位、
// 行号栏整体歪掉、方向键上下移动跨错行」。上下留白必须全部折进 padding。
check('块注释卡片没有垂直 margin（会被高度图漏算）', () => {
	const code = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8');
	const start = code.indexOf('.dle-doc {');
	assert(start > -1, '产物里应该有 .dle-doc 规则');
	const rule = code.slice(start, code.indexOf('}', start));
	const margin = /margin:\s*([^;]+);/.exec(rule);
	assert(margin !== null, '.dle-doc 应该显式声明 margin');
	const [top, right, bottom, left] = margin[1].trim().split(/\s+/);
	assert(token(top) === '0px' || token(top) === '0', `.dle-doc 的上 margin 必须是 0，实际是 ${top}`);
	assert(token(bottom) === '0px' || token(bottom) === '0', `.dle-doc 的下 margin 必须是 0，实际是 ${bottom}`);
	// 四值写法才说明作者是按「上 右 下 左」逐边想过；单值/双值容易写回垂直留白。
	assert(right !== undefined && left !== undefined, '.dle-doc 的 margin 要用四值写法，逐边明确');
});

// 高度估值为 -1 时 CodeMirror 先按「一行行高」估位，真实测量回来再纠正，
// 那一下就是滚动/方向键看到的跳动。给个和渲染规模相当的估值能抹掉它。
check('块注释 widget 提供高度估值', () => {
	const code = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8');
	assert(code.includes('get estimatedHeight'), 'DocCommentWidget 要覆写 estimatedHeight');
	assert(/get estimatedHeight\(\)\s*\{[^}]*Math\.max\(24/.test(code), '估值要有下限，避免极短注释估成负值');
});

// KaTeX 只打包 JS，CSS 与字体交给 DSH 页面——它全局加载的 vendor 样式表里
// 已经有 25 条 .katex 规则和 20 个 @font-face，重复打包就是白付 28 万字符。
check('只打包 KaTeX 的 JS，样式交给宿主页面', () => {
	const code = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8');
	assert(code.includes('__DCH_KATEX__'), '产物里要内联 KaTeX');
	assert(code.includes('__DCH_ENSURE_KATEX__'), '要把惰性入口暴露给 markdown-lite');
	assert(!code.includes('.katex-display{text-align:center'), '不该内联 katex.min.css');
	assert(!code.includes('KaTeX_Main-Regular'), '不该内联 KaTeX 字体');
});

// 公式抽在 HTML 转义之前：先转义会把 `\frac` 的反斜杠吃掉。
// 哨兵用 \u0001（公式）与 \u0000（行内代码）两套，互不干扰。
check('公式在转义之前抽出，且与行内代码用不同哨兵', () => {
	const code = readFileSync(fileURLToPath(new URL('../src/markdown-lite.js', import.meta.url)), 'utf8');
	const extract = code.indexOf('extractInlineMath');
	const escape = code.indexOf('escapeHtml(math.text)');
	assert(extract > -1 && escape > -1, '两处都应存在');
	assert(extract < escape, 'extractInlineMath 必须在 escapeHtml 之前调用');
	assert(code.includes('\\u0001'), '公式哨兵要用 \\u0001');
	assert(code.includes('\\u0000'), '行内代码哨兵要用 \\u0000');
});

// 阶段 1（A）的接线：这几条都是「模块写了但没接进 state / 没接进菜单」才会犯的错，
// 而这类错在浏览器里表现为「按钮点了没反应」，纯函数单测完全看不出来。
check('折叠扩展接进编辑器，且 foldService 用 Facet 的 .of()', () => {
	const code = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8');
	assert(code.includes('createFolding'), '要内联 folding.js');
	assert(code.includes('foldService.of('), 'foldService 是 Facet，必须 .of(handler)');
	assert(!/kit\.foldService\(/.test(code), '不能把 Facet 当函数调用');
	assert(code.includes('codeFolding('), '要启用 codeFolding');
	assert(code.includes('foldGutter('), '要有折叠槽');
});

check('五个新页签与八个菜单项都在产物里', () => {
	const code = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8');
	for (const label of ['目标', '大纲', '引用', '建议', '设置']) {
		assert(code.includes(label), `缺少页签：${label}`);
	}
	for (const label of ['跳转到定义', '查找引用', '获取建议', '文档大纲', '折叠所有证明', '展开全部']) {
		assert(code.includes(label), `缺少菜单项：${label}`);
	}
});

check('infoview 配置真的会被回灌（saveConfig 不再是空实现）', () => {
	const code = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8');
	assert(!/saveConfig:\s*async\s*\(\)\s*=>\s*\{\s*\}/.test(code), 'saveConfig 不能是空函数');
	assert(code.includes('changedInfoviewConfig'), '要把配置推回 infoview');
	assert(code.includes('mergeInfoviewConfig'), '要用合并（挡掉未知键）');
	assert(code.includes('sameInfoviewConfig'), '要短路，否则会无限回灌');
});

check('Try this 请求会把当前行的诊断带上', () => {
	const code = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8');
	assert(code.includes('diagnosticsOnLine'), '要按行筛诊断');
	assert(code.includes('rankCodeActions'), '要排序');
	assert(code.includes('editsForPath'), '应用时只取本文件的编辑');
	const index = code.indexOf('requestSuggestions = useCallback');
	assert(index > -1, '要有 requestSuggestions');
	const body = code.slice(index, index + 1600);
	assert(body.includes('diagnosticsOnLine'), 'requestSuggestions 内部要筛诊断');
	assert(body.includes('codeActions'), 'requestSuggestions 要发 codeActions');
});

check('Ctrl+Click 拦在 mousedown（等 CM 处理完选区就变了）', () => {
	const code = readFileSync(fileURLToPath(new URL('../src/editor.js', import.meta.url)), 'utf8');
	assert(code.includes('mousedown'), '要在 mousedown 拦');
	assert(code.includes('ctrlKey') && code.includes('metaKey'), '要认 Ctrl 与 Cmd');
	assert(code.includes('onGotoDefinition'), '要回传跳转请求');
	assert(code.includes('posAtCoords'), '要用坐标换算位置');
});

check('查看器的相对路径会先接到会话 cwd 上（否则 Lean 起不来）', () => {
	const code = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8');
	assert(code.includes('viewerPathOf'), '要导出并使用 viewerPathOf');
	assert(code.includes('sessionCwdOf'), '要读会话 cwd');
	/* createLspClient 必须拿到拼好的绝对路径，而不是查看器原样给的相对路径。 */
	const index = code.indexOf('const lspPath = viewerPathOf(');
	assert(index > -1, '要算出 lspPath');
	const body = code.slice(index, index + 400);
	assert(body.includes('path: lspPath'), 'LSP 客户端要用 lspPath');
});

check('宿主半对不存在的路径直接报 unknown-file，并给重建加退避', () => {
	const code = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8');
	assert(code.includes('unknown-file'), '要有 unknown-file 错误码');
	assert(code.includes('isDirectory'), '要检查工程根目录真的存在');
	assert(code.includes('FAIL_BACKOFF_MS'), '要有退避表');
	assert(code.includes('MAX_STRIKES'), '要有熔断阈值');
	assert(code.includes('failureBlock'), '要能把失败翻译成人话');
	/* 退出必须留下证据：桌面端没有控制台，只能看宿主日志。 */
	assert(code.includes('[lean] exited code='), '退出时要写日志');
});

check('Agent 工具用 inject 回调给的 scoped ctx 注册', () => {
	const code = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8');
	assert(code.includes('registerAgentTools(scoped)'), '要把 scoped 传进去');
	const index = code.indexOf("ctx.inject(['tools']");
	assert(index > -1, '要用 ctx.inject 等 tools 服务');
	/* 0.8.0 的 bug：闭包里读外层 ctx.tools，cordis 判 without inject → 九个工具全没注册上。 */
	assert(!/registerAgentTools\(\)/.test(code), '不能再用无参版本');
});

function token(value) {
	return String(value).trim();
}

if (failures.length > 0) {
	console.error(`client-bundle: ${passed} 通过 / ${failures.length} 失败`);
	for (const failure of failures) console.error(`  ✗ ${failure}`);
	process.exit(1);
}
console.log(`client-bundle: ${passed}/${passed} 通过`);
