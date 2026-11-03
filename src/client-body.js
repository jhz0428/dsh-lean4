// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// 浏览器半：把「.lean 文件 → 可编辑的 Lean 编辑器」注册进 better-sidebar。
//
// 为什么是 FileViewer 而不是语言扩展：better-sidebar 的「后缀 → 语言」是内置编辑器
// 里写死的（`src/client/lang.ts` 的 switch），插件拿不到那个位置；但
// `registerFileViewer` 是公开席位，而 `exts` 命中后组件完全由我提供——于是自带
// 一个 CodeMirror，自己决定语法、主题与保存。
//
// 契约要点（docs/external-plugin-guide.md）：
//   §5.1 registerFileViewer({ id, title, exts, priority, fetchStrategy, component })
//   §5.2 props 给 content / mtimeMs（fsRead），dirty 必须如实上报
//   §6   保存 POST /sidebar/write?sessionId=&path=&expectedMtimeMs=，body 是 LF 文档

import { mountEditor } from './editor.js';
import { viewerPathOf } from './paths.js';
import { createLspClient } from './lean-lsp.js';
import { attachLsp } from './lsp-extensions.js';
import { mountInfoview, insertInfoviewStyle } from './infoview.js';
import { readInfoviewConfig, writeInfoviewConfig, INFOVIEW_TOGGLES, EXPECTED_TYPE_VISIBILITY, MESSAGE_ORDER } from './infoview-config.js';
import { createDocMarkdown } from './doc-markdown.js';
import { createProvenMarks, accomplishedLines, taskMarks } from './gutter-marks.js';
import { createFolding, foldProofs, unfoldEverywhere } from './folding.js';
import { rankCodeActions, editsForPath, diagnosticsOnLine } from './code-actions.js';
import { outlineRows, filterSymbols, splitLocations, formatLocation } from './navigation.js';
import { appendToComposer, describeComposerFailure, selectionBlock } from './conversation.js';
import { resolveRoute, writeUrl, readWriteEnvelope } from './save.js';
import { insertStyle } from './style.js';

export const PLUGIN_ID = 'dsh-lean4';
export const VIEWER_ID = 'lean-editor:lean';
/** 认领的后缀。任务限定 `.lean`；加更多是改这一个数组的事。 */
export const EXTENSIONS = ['lean'];
/** 内置 `code` 兜底是 -100，只要比它高就能赢；留 10 给将来插入。 */
export const VIEWER_PRIORITY = 10;

function describe(error) {
	if (error !== null && typeof error === 'object' && typeof error.message === 'string') return error.message;
	return String(error);
}

function formatSize(bytes) {
	if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '未知大小';
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

/** `EditorToolbarState.saveState` 只有四档，冲突与失败都归 `failed`。 */
function saveStateOf(status) {
	if (status === 'saving') return 'saving';
	if (status === 'saved') return 'saved';
	if (status === 'conflict' || status === 'failed') return 'failed';
	return 'idle';
}

/**
 * 造组件。`React` 由 ModuleLoader 的 `require` 提供——插件不打包自己的 React，
 * 否则 hook 会跨实例而直接崩。
 */
/** `{line, character}`（0 基）→ CodeMirror 文档偏移；越界就夹到行尾。 */
/**
 * 惰性加载 infoview bundle。
 *
 * 这份 vendor 求值时会摸 document，所以构建期把它包进了 ensureInfoviewBundle，
 * 只有真要挂面板时才执行；单测或纯逻辑环境里返回 null，退回自带的极简目标面板。
 */
/*
 * 官方 infoview 求值时会向 `customElements` 注册一堆 `vscode-*` 元素。
 * 同一份 bundle 被求值两次（页面刷新后模块重新创建、或两个编辑器实例抢跑）
 * 就会撞 `Failed to execute 'define' on 'CustomElementRegistry'`，整块面板直接挂。
 * 重名注册其实无害——同名同义——所以这里把 define 包一层，只吞「已存在」这一种错。
 */
const CUSTOM_ELEMENTS_SHIM = Symbol.for('dsh-lean4.customElementsShim');

function installCustomElementShim() {
	const registry = globalThis.customElements;
	if (registry === undefined || registry === null || registry[CUSTOM_ELEMENTS_SHIM] === true) return;
	const define = registry.define;
	if (typeof define !== 'function') return;
	registry[CUSTOM_ELEMENTS_SHIM] = true;
	registry.define = function defineElement(name, constructor, options) {
		try {
			return define.call(this, name, constructor, options);
		} catch (error) {
			const message = typeof error?.message === 'string' ? error.message : '';
			if (message.includes('has already been used with this registry')) return undefined;
			throw error;
		}
	};
}

function loadInfoviewBundle() {
	try {
		/* 先认已经加载好的那份：模块被重建时不该再求值一遍 vendor。 */
		const ready = globalThis.__DCH_INFOVIEW__;
		if (typeof ready === 'object' && ready !== null) return { module: ready, reason: '' };
		if (typeof ensureInfoviewBundle === 'function') {
			installCustomElementShim();
			const module = ensureInfoviewBundle();
			if (module === null || module === undefined) return { module: null, reason: 'vendor-null' };
			return { module, reason: '' };
		}
		// 走到这里说明浏览器手上这份 client.js 根本没有惰性 bundle —— 典型是缓存了旧版。
		return { module: null, reason: 'stale' };
	} catch (error) {
		return { module: null, reason: `threw: ${describe(error)}` };
	}
}

function offsetFrom(doc, line, character) {
	const index = Number.isInteger(line) ? line + 1 : 1;
	if (index < 1 || index > doc.lines) return doc.length;
	const at = doc.line(index);
	return Math.min(at.from + Math.max(0, Number(character) || 0), at.to);
}

/** 宿主推来的扁平诊断 → LSP 的 `Diagnostic`（infoview 直接吃这个形状）。 */
function toLspDiagnostic(item) {
	return {
		range: {
			start: { line: Number(item.startLine) || 0, character: Number(item.startCharacter) || 0 },
			end: { line: Number(item.endLine) || 0, character: Number(item.endCharacter) || 0 }
		},
		severity: item.severity,
		message: item.message,
		code: item.code,
		source: item.source,
		tags: item.tags
	};
}

function createView(React) {
	const { useCallback, useEffect, useRef, useState } = React;

	return function LeanEditorView(props) {
		const { ctx, scope, path, content, mtimeMs, largeFile, line, onLineConsumed, onToolbarState, onToolbarControls, onReload } = props;
		const hostRef = useRef(null);
		const editorRef = useRef(null);
		/** 保存冲突基线：最近一次「已知的磁盘 mtime」。undefined = 不做门禁。 */
		const baselineRef = useRef(typeof mtimeMs === 'number' ? mtimeMs : undefined);
		const dirtyRef = useRef(false);
		const toolbarRef = useRef(onToolbarState);
		const [status, setStatus] = useState('idle');
		const [message, setMessage] = useState('');
		/** Lean 语言服务器的状态：idle → starting → ready / failed。 */
		const [leanState, setLeanState] = useState('idle');
		const infoviewRef = useRef(null);
		const bridgeRef = useRef(null);
		const [leanDetail, setLeanDetail] = useState('');
		/** 光标处的目标（plainGoal 的 goals 数组）；null = 没有目标。 */
		const [goals, setGoals] = useState(null);
		const [busy, setBusy] = useState(false);
		const [infoviewReady, setInfoviewReady] = useState(false);
		const [infoviewNote, setInfoviewNote] = useState('');
		/* 面板右上角的读数：诊断总数与「目标已完成」条数，用来分辨「服务端没发」和「界面没画」。 */
		const [diagInfo, setDiagInfo] = useState(null);
		/** 服务器信息的小字提示（版本号缺失等），只写在侧栏标题旁，不当故障报红条。 */
		const [serverNote, setServerNote] = useState('');
		const [sideOpen, setSideOpen] = useState(true);
		const [chatNote, setChatNote] = useState('');
		/** 右键菜单：`{ left, top, hasSelection }`，坐标相对 `.dle-host`。 */
		const [menu, setMenu] = useState(null);
		const menuRef = useRef(null);
		const lspRef = useRef(null);
		const detachRef = useRef(null);
		/** 文档注释渲染 / 双对勾的两个扩展控制柄（挂载时填）。 */
		const docMarkdownRef = useRef(null);
		const provenRef = useRef(null);
		const [docRender, setDocRender] = useState(true);
		/* 折叠：区间来自 LSP，`foldProofs` 再按行首关键字挑证明段。 */
		const foldingRef = useRef(null);
		const rangesRef = useRef([]);
		const foldTimerRef = useRef(null);
		/* 任务列的两路输入：诊断与文件进度（谁后到就用谁的快照重画）。 */
		const diagRef = useRef([]);
		const processingRef = useRef([]);
		/* 右栏页签：目标（infoview）/ 大纲 / 引用 / 建议。 */
		const [sideTab, setSideTab] = useState('goals');
		const [outline, setOutline] = useState(null);
		const [outlineQuery, setOutlineQuery] = useState('');
		const [refs, setRefs] = useState(null);
		const [suggestions, setSuggestions] = useState(null);
		const [foldNote, setFoldNote] = useState('');
		/* infoview 的 13 项配置：初值从 localStorage 读，改动回写并回灌面板。 */
		const [infoviewConfig, setInfoviewConfig] = useState(
			() => readInfoviewConfig(typeof localStorage === 'undefined' ? undefined : localStorage)
		);
		/* 挂载 effect 只跑一次，用 ref 把最新的配置递给它（配置变了不必重挂 infoview）。 */
		const infoviewConfigRef = useRef(infoviewConfig);

		// 宿主每次渲染都可能给新的回调，用 ref 拿最新的，避免 effect 反复重挂。
		useEffect(() => {
			toolbarRef.current = onToolbarState;
		}, [onToolbarState]);

		useEffect(() => {
			const report = toolbarRef.current;
			if (typeof report !== 'function') return;
			report({
				modes: false,
				mode: 'edit',
				dirty: dirtyRef.current,
				editable: true,
				saveState: saveStateOf(status)
			});
		}, [status, message]);

		const save = useCallback(async () => {
			const editor = editorRef.current;
			if (editor === null) return;
			let route;
			try {
				route = resolveRoute(ctx.betterSidebar, 'sidebar/write');
			} catch (error) {
				setStatus('failed');
				setMessage(`无法解析保存路由：${describe(error)}`);
				return;
			}
			const url = writeUrl(route, { sessionId: scope.sessionId, path, expectedMtimeMs: baselineRef.current });
			setStatus('saving');
			setMessage('');
			let response;
			try {
				response = await fetch(url, {
					method: 'POST',
					headers: { 'content-type': 'text/plain; charset=utf-8' },
					body: editor.getDoc()
				});
			} catch (error) {
				setStatus('failed');
				setMessage(`保存请求失败：${describe(error)}`);
				return;
			}
			let payload = null;
			try {
				payload = await response.json();
			} catch {
				payload = null;
			}
			const result = readWriteEnvelope(response.status, payload);
			if (result.kind === 'saved') {
				if (typeof result.mtimeMs === 'number') baselineRef.current = result.mtimeMs;
				dirtyRef.current = false;
				setStatus('saved');
				setMessage('');
				return;
			}
			if (result.kind === 'conflict') {
				setStatus('conflict');
				setMessage(`磁盘上的文件已变化，保存被拒绝（${result.message}）`);
				return;
			}
			setStatus('failed');
			setMessage(`保存失败：${result.message}`);
		}, [ctx, path, scope]);

		/** 重启语言服务器；重启后必须把当前文本重新推过去，否则服务器不知道这份文档。 */
		const restartLsp = useCallback(async () => {
			const lsp = lspRef.current;
			if (lsp === null) return;
			setLeanState('starting');
			setLeanDetail('');
			try {
				await lsp.restart();
				const detach = detachRef.current;
				/* 重启后服务器也没有这份文档了，必须重新 open（syncNow 只会发 change）。 */
				if (detach !== null) await detach.reconnect();
			} catch (error) {
				setLeanState('failed');
				setLeanDetail(describe(error));
			}
		}, []);

		const editable = typeof content === 'string' && largeFile === undefined;

		// 挂载只做一次：重挂会丢光标与撤销栈。
		const currentPosition = () => {
			const editor = editorRef.current;
			if (editor === null) return { line: 0, character: 0 };
			const head = editor.view.state.selection.main.head;
			const at = editor.view.state.doc.lineAt(head);
			return { line: at.number - 1, character: head - at.from };
		};

		/** infoview 的「复制到注释」/ widget 动作都靠这三个方法落回编辑器。 */
		const insertText = (text, kind, pos) => {
			const editor = editorRef.current;
			if (editor === null) return;
			const view = editor.view;
			const from = pos?.position === undefined
				? view.state.selection.main.head
				: offsetFrom(view.state.doc, pos.position.line, pos.position.character);
			const payload = kind === 'above' ? `
${text}` : kind === 'below' ? `${text}
` : text;
			view.dispatch({ changes: { from, insert: payload }, selection: { anchor: from + payload.length } });
		};

		const applyChanges = (changes) => {
			const editor = editorRef.current;
			if (editor === null) return;
			const view = editor.view;
			const doc = view.state.doc;
			const mapped = changes
				.map((change) => ({
					from: offsetFrom(doc, change.range?.start?.line, change.range?.start?.character),
					to: offsetFrom(doc, change.range?.end?.line, change.range?.end?.character),
					insert: typeof change.newText === 'string' ? change.newText : ''
				}))
				.sort((left, right) => right.from - left.from);
			view.dispatch({ changes: mapped });
		};

		const revealPosition = (position) => {
			const editor = editorRef.current;
			if (editor === null) return;
			const view = editor.view;
			const offset = offsetFrom(view.state.doc, position?.line, position?.character);
			view.dispatch({ selection: { anchor: offset }, effects: DCM.EditorView.scrollIntoView(offset) });
			view.focus();
		};

		/**
		 * 拉一次折叠区间并写进折叠 extension。
		 *
		 * 拉不到就**保留上一次的区间**：服务器临时在重启时把已经折好的段全部弹开，
		 * 用户正看着的代码会突然展开一屏，比保留旧区间（行号可能偏一点）难用得多。
		 */
		const syncFolding = useCallback(async () => {
			const lsp = lspRef.current;
			const folding = foldingRef.current;
			const editor = editorRef.current;
			if (lsp === null || folding === null || editor === null) return;
			try {
				const value = await lsp.foldingRanges();
				const ranges = folding.apply(editor.view, value?.ranges ?? []);
				rangesRef.current = ranges;
				setFoldNote('');
			} catch (error) {
				setFoldNote(`折叠区间获取失败：${describe(error)}`);
			}
		}, []);

		/** 文档改过之后区间可能整体错行。等 1.2 秒再拉，免得每个字符都发一次请求。 */
		const scheduleFoldSync = useCallback(() => {
			if (foldTimerRef.current !== null) clearTimeout(foldTimerRef.current);
			foldTimerRef.current = setTimeout(() => {
				foldTimerRef.current = null;
				void syncFolding();
			}, 1200);
		}, [syncFolding]);

		const foldProofsNow = useCallback(() => {
			const editor = editorRef.current;
			const folding = foldingRef.current;
			if (editor === null || folding === null) return;
			try {
				const count = foldProofs(editor.view, DCM, rangesRef.current);
				setFoldNote(count === 0 ? '没有可折叠的多行证明' : `折叠了 ${count} 段证明`);
			} catch (error) {
				setFoldNote(`折叠失败：${describe(error)}`);
			}
		}, []);

		const unfoldNow = useCallback(() => {
			const editor = editorRef.current;
			if (editor === null) return;
			unfoldEverywhere(editor.view, DCM);
			setFoldNote('已全部展开');
		}, []);

		/**
		 * 跳到某个位置。
		 *
		 * 只处理「当前文件」——其它文件我们手上没有打开的编辑器，跳过去也只能是
		 * 一句提示。把两种结果分开说，用户才不会以为点了没反应。
		 */
		const gotoLocation = useCallback((location) => {
			if (location?.path === path) {
				revealPosition(location.range?.start ?? { line: 0, character: 0 });
				setChatNote('');
				return;
			}
			setChatNote(`在 ${formatLocation(location)}（其它文件，用左侧文件树打开）`);
		}, [path, revealPosition]);

		const gotoDefinition = useCallback(async (position) => {
			const lsp = lspRef.current;
			if (lsp === null) return;
			try {
				const value = await lsp.definition(position);
				const list = Array.isArray(value?.locations) ? value.locations : [];
				if (list.length === 0) {
					setChatNote('没有找到定义');
					return;
				}
				gotoLocation(list[0]);
			} catch (error) {
				setChatNote(`跳转失败：${describe(error)}`);
			}
		}, [gotoLocation]);

		const findReferences = useCallback(async () => {
			const lsp = lspRef.current;
			if (lsp === null) {
				setChatNote('Lean 未连接');
				return;
			}
			const at = currentPosition();
			try {
				const value = await lsp.references(at, true);
				const list = Array.isArray(value?.locations) ? value.locations : [];
				const split = splitLocations(list, path);
				setRefs({
					title: `引用（${list.length}）`,
					items: list.map((item) => ({
						...item,
						label: formatLocation(item, undefined),
						local: item.path === path,
					})),
					localCount: split.local.length,
					externalCount: split.external.length,
				});
				setSideTab('refs');
				setSideOpen(true);
			} catch (error) {
				setChatNote(`查找引用失败：${describe(error)}`);
			}
		}, [path]);

		const loadOutline = useCallback(async () => {
			const lsp = lspRef.current;
			if (lsp === null) {
				setChatNote('Lean 未连接');
				return;
			}
			try {
				const value = await lsp.documentSymbols();
				setOutline(outlineRows(value?.symbols ?? []));
				setSideTab('outline');
				setSideOpen(true);
			} catch (error) {
				setChatNote(`大纲获取失败：${describe(error)}`);
			}
		}, []);

		/**
		 * 问一次「建议」（`Try this`）。
		 *
		 * 必须把**当前行相交的诊断**带回去：Lean 的 provider 是按诊断里的 code/source
		 * 反查 info tree 的，只给一个空区间它什么都不吐（探针实测：空 context 也能拿到
		 * action，但那只在服务器刚好缓存了该位置的 info 树时成立，不能依赖）。
		 */
		const requestSuggestions = useCallback(async () => {
			const lsp = lspRef.current;
			const editor = editorRef.current;
			if (lsp === null || editor === null) {
				setChatNote('Lean 未连接');
				return;
			}
			const state = editor.view.state;
			const range = state.selection.main;
			const from = state.doc.lineAt(range.from);
			const to = state.doc.lineAt(range.to);
			const lspRange = {
				start: { line: from.number - 1, character: 0 },
				end: { line: to.number - 1, character: to.length }
			};
			try {
				const snapshot = await lsp.diagnostics();
				const list = diagnosticsOnLine(snapshot?.diagnostics ?? [], from.number - 1);
				const value = await lsp.codeActions(lspRange, list);
				const actions = rankCodeActions(value?.actions ?? []);
				setSuggestions(actions);
				setSideTab('suggest');
				setSideOpen(true);
				if (actions.length === 0) setChatNote('这一行没有可用建议');
			} catch (error) {
				setChatNote(`获取建议失败：${describe(error)}`);
			}
		}, []);

		const applyAction = useCallback((action) => {
			const edits = editsForPath(action, path);
			if (edits.length === 0) {
				setChatNote('这条建议改的是别的文件，这里应用不了');
				return;
			}
			try {
				applyChanges(edits);
				setChatNote('已应用建议');
			} catch (error) {
				setChatNote(`应用失败：${describe(error)}`);
			}
		}, [path, applyChanges]);

		/**
		 * 改一项 infoview 配置：写 localStorage 并回灌面板。
		 *
		 * 回灌走 `bridge.setConfig`，与 infoview 自己改配置是同一条路 —— 两边各改一份
		 * 配置会让面板显示的开关与实际行为对不上。
		 */
		const setConfigField = useCallback((key, value) => {
			setInfoviewConfig((previous) => {
				const next = { ...previous, [key]: value };
				infoviewConfigRef.current = next;
				writeInfoviewConfig(typeof localStorage === 'undefined' ? undefined : localStorage, next);
				const bridge = bridgeRef.current;
				if (bridge !== null && typeof bridge.setConfig === 'function') {
					try {
						bridge.setConfig(next);
					} catch (error) {
						console.warn('[lean-editor] infoview 配置回灌失败：', error);
					}
				}
				return next;
			});
		}, []);

		useEffect(() => {
			if (!editable) return undefined;
			const host = hostRef.current;
			if (host === null) return undefined;
			if (typeof DCM === 'undefined' || DCM === null) {
				setStatus('failed');
				setMessage('编辑器运行时未加载（CodeMirror 包缺失）');
				return undefined;
			}
			const docMarkdown = createDocMarkdown(DCM);
			const proven = createProvenMarks(DCM);
			const folding = createFolding(DCM);
			docMarkdownRef.current = docMarkdown;
			provenRef.current = proven;
			foldingRef.current = folding;
			const editor = mountEditor(DCM, host, {
				doc: content,
				extras: [docMarkdown.extension, proven.extension, folding.extension],
				onDocChanged: () => {
					dirtyRef.current = true;
					setStatus('idle');
					scheduleFoldSync();
				},
				onSave: () => {
					void save();
				},
				onCursor: (position) => bridgeRef.current?.cursor(position),
				onGotoDefinition: (position) => {
					void gotoDefinition(position);
				},
				onContextMenu: (at) => {
					const host = hostRef.current;
					if (host === null) {
						setMenu(null);
						return;
					}
					const rect = host.getBoundingClientRect();
					// 贴边就翻到左侧/上侧，别让菜单跑出可视区（菜单现在有七项，要留够高度）。
					const left = Math.max(4, Math.min(at.clientX - rect.left, Math.max(4, rect.width - 190)));
					const top = Math.max(4, Math.min(at.clientY - rect.top, Math.max(4, rect.height - 240)));
					setMenu({ left, top, hasSelection: at.hasSelection });
				}
			});
			editorRef.current = editor;
			if (typeof line === 'number' && line > 0) editor.revealLine(line);
			// LSP 是增强项：连不上也只是没有诊断与目标，编辑与保存照常。
			let lsp = null;
			let detach = null;
			try {
				/*
				 * 查看器给的 path 可能是相对会话工作目录的（`施工方案/PlanSpec.lean`）。
				 * 保存接口能按 sessionId 自己补基准，LSP 这边不行 —— 宿主半只有
				 * process.cwd()，拼出来的目录往往不存在，`lean --server` 于是起不来。
				 * 所以在交给宿主半之前先补成绝对路径。
				 */
				const lspPath = viewerPathOf(ctx, scope?.sessionId, path);
				lsp = createLspClient({
					baseUrl: typeof document !== 'undefined' && typeof document.baseURI === 'string' ? document.baseURI : 'http://localhost/',
					path: lspPath
				});
				lspRef.current = lsp;
				/*
				 * 「服务器就绪」这件事对 infoview 来说是硬契约：它要
				 * `serverInfo.version` 才能建出 ServerVersion，缺了就在自己树里抛错、
				 * 整个面板渲染失败。SSE 的 status 事件比第一次 pull 更早到，所以这里
				 * 缺字段时补一次 pull 再喂。
				 */
				const feedServerInfo = async (target) => {
					let known = target.lastPull;
					if (known === null || known === undefined || known.serverInfo === undefined) {
						try {
							known = await target.pull();
						} catch (error) {
							setInfoviewNote(`拉取 Lean 服务器信息失败：${describe(error)}`);
							return;
						}
					}
					const info = known?.serverInfo;
					const version = typeof info?.version === 'string' ? info.version.trim() : '';
					/*
					 * infoview 的 `ServerVersion.ofString` 只认 2/3 段版本号，喂空串会在它
					 * 自己的 React 树里抛错、整块面板白掉。但「拿不到版本号」并不等于
					 * 「infoview 不能用」——宿主半是旧进程时 pull 里没有 serverInfo，
					 * 面板其实照样能画。所以这里给一个占位版本号让它渲染，提示只落在
					 * 侧栏小字里，不当故障报红条。
					 */
					setServerNote(version === '' ? '服务器版本未知（宿主半较旧），已按 0.0.0 处理' : '');
					bridgeRef.current?.serverReady(
						known?.capabilities,
						version === '' ? { name: info?.name ?? 'Lean 4 Server', version: '0.0.0' } : info
					);
					bridgeRef.current?.cursor(currentPosition());
				};
				// 光标位置既给目标面板兜底，也给 infoview 决定显示哪个位置的 goal/widget。
				/*
				 * 任务列的数据源有两个：诊断（→ ✓ 证明完成）与文件进度（→ ◐ 正在处理）。
				 * 它们分别从两条路径到达，所以两路都只是刷新同一个 ref 再重画一次；
				 * 谁先到都不会把另一方的标记抹掉。
				 */
				const pushMarks = () => {
					const marks = provenRef.current;
					if (marks === null || typeof marks.setLines?.of !== 'function') return '';
					const list = taskMarks(diagRef.current, processingRef.current);
					editor.view.dispatch({ effects: marks.setLines.of(list) });
					return '';
				};
				detach = attachLsp(DCM, editor.view, lsp, {
					onGoal: (next) => setGoals(next === null || next.goals.length === 0 ? null : next.goals),
					onStatus: (event) => {
						const state = event.state === undefined ? 'idle' : event.state;
						setLeanState(state);
						setLeanDetail(typeof event.detail === 'string' ? event.detail : '');
						if (state === 'ready') {
							void feedServerInfo(lsp);
							/* 就绪才有折叠区间可拿；早问只会得到服务端未初始化的错误。 */
							void syncFolding();
						} else if (state === 'failed') {
							bridgeRef.current?.serverStopped(event.detail ?? '', 'Lean 服务器已停止');
						}
					},
					onProgress: (processing) => {
						processingRef.current = processing;
						setBusy(processing.length > 0);
						try {
							pushMarks();
						} catch {
							/* 编辑器销毁是正常的 */
						}
					},
					/*
					 * 用 `onDiagnosticsRaw` 而不是 `onDiagnostics`：后者的列表已经过
					 * `toCmDiagnostics` 过滤，`isSilent: true` 的 GoalsAccomplished 诊断
					 * 全被剔掉，对勾永远拿不到行号。
					 */
					onDiagnosticsRaw: (list) => {
						setBusy(false);
						diagRef.current = Array.isArray(list) ? list : [];
						// Lean 用信息级诊断 `leanTags: [2]` 标记「目标已解决」，把它变成行号栏的 ✓。
						const lines = accomplishedLines(list);
						let failure = '';
						try {
							failure = pushMarks();
						} catch (error) {
							/* 编辑器销毁是正常的；其它异常要露出来，否则「有数据不显示」无从查起。 */
							failure = describe(error);
						}
						const sample = Array.isArray(list) && list.length > 0 ? list[0] : null;
						setDiagInfo({
							total: Array.isArray(list) ? list.length : 0,
							tagged: lines.length,
							failure,
							sample
						});
					}
				});
				detachRef.current = detach;
				// infoview 是可选增强：模块缺失（例如单测环境）就退回自带的极简目标面板。
				const loaded = loadInfoviewBundle();
				const infoviewModule = loaded.module;
				if (infoviewModule === null) {
					if (loaded.reason === 'stale') {
						setInfoviewNote(
							'infoview 未加载：浏览器手上的是旧版 lib/client.js（里面没有内置 bundle）。'
							+ '请按 Ctrl+Shift+R 强制刷新；仍不行就重启桌面端。'
						);
					} else if (loaded.reason === 'vendor-null') {
						setInfoviewNote('infoview bundle 求值后没有暴露 __DCH_INFOVIEW__（vendor 与包装不匹配）');
					} else {
						setInfoviewNote(`infoview bundle 求值失败：${loaded.reason.replace(/^threw: /, '')}`);
					}
				}
				if (infoviewModule !== null && infoviewRef.current !== null) {
					try {
						insertInfoviewStyle(document, typeof INFOVIEW_CSS === 'string' ? INFOVIEW_CSS : '');
						bridgeRef.current = mountInfoview({
							module: infoviewModule,
							element: infoviewRef.current,
							client: lsp,
							uri: lsp.uri,
							config: infoviewConfigRef.current,
							/*
							 * infoview 自己改了配置（面板右键菜单里那些开关）→ 记下来，
							 * 下次打开同一个文件时还是用户选的那套。
							 */
							onConfigChange: (next) => {
								infoviewConfigRef.current = next;
								writeInfoviewConfig(
									typeof localStorage === 'undefined' ? undefined : localStorage,
									next
								);
								setInfoviewConfig(next);
							},
							editor: {
								getText: () => editor.getDoc(),
								getCursor: () => {
									const head = editor.view.state.selection.main.head;
									const at = editor.view.state.doc.lineAt(head);
									return { line: at.number - 1, character: head - at.from };
								},
								insertText,
								applyChanges,
								revealPosition
							}
						});
						setInfoviewReady(true);
						/*
						 * 兜住 infoview 自己那棵 React 树的报错。它渲染失败只会留下一个空 div，
						 * 而桌面端看不到控制台 —— 抓 1.5 秒的全局错误，把第一条写进面板提示。
						 */
						const captured = [];
						const onWindowError = (event) => captured.push(String(event?.message ?? event));
						const onUnhandled = (event) => captured.push(String(event?.reason?.message ?? event?.reason ?? ''));
						const previousConsoleError = console.error;
						const onConsoleError = (...args) => {
							captured.push(args.map((value) => (value instanceof Error ? value.message : String(value))).join(' '));
							previousConsoleError.apply(console, args);
						};
						window.addEventListener('error', onWindowError);
						window.addEventListener('unhandledrejection', onUnhandled);
						console.error = onConsoleError;
						globalThis.setTimeout?.(() => {
							window.removeEventListener('error', onWindowError);
							window.removeEventListener('unhandledrejection', onUnhandled);
							if (console.error === onConsoleError) console.error = previousConsoleError;
							if (captured.length === 0) return;
							/*
							 * 只有「面板真的是空的」才报错。infoview 内部会有一些无害的
							 * React/布局告警，面板明明画出来了却顶一条红条，用户只会以为
							 * 功能挂了 —— 所以先看它到底有没有内容。
							 */
							const element = infoviewRef.current;
							const drawn = element !== null && element !== undefined && element.childElementCount > 0
								&& (element.textContent ?? '').trim() !== '';
							if (drawn) {
								console.warn('[lean-editor] infoview 已渲染，忽略其内部报错：', captured[0]);
								return;
							}
							setInfoviewNote(`infoview 渲染报错：${captured[0].slice(0, 300)}`);
						}, 1500);
						/*
						 * 空面板自检：infoview 是别人的 React 树，它渲染失败（比如缺上下文）
						 * 只会留下一个空 div —— 用户看到的就是「面板什么都没有」。
						 * 给它足够长的启动时间（首次加载 2.5 MB 的 bundle + React 首帧），
						 * 还没有任何子节点才退回自带的目标面板，并把原因写在标题下。
						 */
						globalThis.setTimeout?.(() => {
							const element = infoviewRef.current;
							if (element === null || element.isConnected === false) return;
							if (element.childElementCount > 0) return;
							setInfoviewReady(false);
							setInfoviewNote('infoview 已挂载但没有渲染内容（可能缺少上层上下文），已退回内置面板');
						}, 8000);
						// 先无条件告诉 infoview 「当前在哪个文件的光标处」——它没有这个
						// 位置就只会画一行 Waiting for Lean server to start...
						bridgeRef.current?.cursor(currentPosition());
						// 桥可能比服务器就绪事件晚到：补一次「已就绪 + 当前光标」，
						const known = lsp.lastPull;
						if (known !== null && known !== undefined && known.state === 'ready' && known.serverInfo !== undefined) {
							bridgeRef.current?.serverReady(known.capabilities, known.serverInfo);
							bridgeRef.current?.cursor(currentPosition());
						}
					} catch (error) {
						const detail = `infoview 挂载失败：${describe(error)}`;
						setLeanDetail(detail);
						setInfoviewNote(detail);
					}
				}
				// 把 SSE 推来的进度/诊断转成 LSP 通知，infoview 自己订阅这两条。
				lsp.onEvent((event) => {
					const bridge = bridgeRef.current;
					if (bridge === null) return;
					if (event.type === 'progress') {
						bridge.notification('$/lean/fileProgress', {
							textDocument: { uri: lsp.uri },
							processing: (event.processing ?? []).map((item) => ({
								range: {
									start: { line: item.startLine, character: 0 },
									end: { line: item.endLine, character: 0 }
								},
								kind: item.kind
							}))
						});
					} else if (event.type === 'diagnostics') {
						bridge.notification('textDocument/publishDiagnostics', {
							uri: lsp.uri,
							diagnostics: (event.diagnostics ?? []).map(toLspDiagnostic)
						});
					}
				});
			} catch (error) {
				setLeanState('failed');
				setLeanDetail(describe(error));
			}
			// 挂载后立刻把 dirty=false 报给宿主，否则宿主会以为这里永远脏。
			const report = toolbarRef.current;
			if (typeof report === 'function') {
				report({ modes: false, mode: 'edit', dirty: false, editable: true, saveState: 'idle' });
			}
			return () => {
				bridgeRef.current?.dispose();
				bridgeRef.current = null;
				detach?.dispose();
				detachRef.current = null;
				lspRef.current = null;
				editor.destroy();
				editorRef.current = null;
			};
		}, []);

		// 宿主重载（模型改完文件 / 用户点刷新）→ 换文档但不重挂。
		useEffect(() => {
			const editor = editorRef.current;
			if (editor === null || typeof content !== 'string') return;
			if (editor.getDoc() === content) return;
			editor.setDoc(content);
			dirtyRef.current = false;
			if (typeof mtimeMs === 'number') baselineRef.current = mtimeMs;
			setStatus('idle');
			setMessage('');
		}, [content, mtimeMs]);

		// 引用里带行号（`a.lean#L42`）→ 滚过去，并回报已消费。
		useEffect(() => {
			const editor = editorRef.current;
			if (editor === null || typeof line !== 'number' || line <= 0) return;
			editor.revealLine(line);
			if (typeof onLineConsumed === 'function') onLineConsumed();
		}, [line]);

		// 把「保存」交给宿主的页头按钮，页头的保存键因此走同一条路。
		useEffect(() => {
			if (typeof onToolbarControls !== 'function') return undefined;
			onToolbarControls({
				setMode() {},
				save: () => {
					void save();
				}
			});
			return () => onToolbarControls(null);
		}, [onToolbarControls, save]);

		if (!editable) {
			const text = largeFile !== undefined
				? `文件过大（${formatSize(largeFile.size)}），编辑器不打开超大文件。请用下载或命令行查看。`
				: '这个文件没有可编辑的文本内容。';
			return React.createElement('div', { className: 'dle-host' }, React.createElement('div', { className: 'dle-notice' }, text));
		}

		const banner = status === 'conflict' || status === 'failed'
			? React.createElement(
				'div',
				{ className: 'dle-banner', 'data-kind': status },
				React.createElement('span', { className: 'dle-banner-text' }, message === '' ? '保存未完成' : message),
				status === 'conflict'
					? React.createElement('button', {
						type: 'button',
						onClick: () => {
							void save();
						}
					}, '仍然保存')
					: null,
				typeof onReload === 'function'
					? React.createElement('button', {
						type: 'button',
						onClick: () => onReload()
					}, '从磁盘重载')
					: null
			)
			: null;

		const saveText = status === 'saving' ? '保存中…' : status === 'saved' ? '已保存' : '';
		const leanText = leanState === 'ready'
			? (busy ? 'Lean 正在检查…' : 'Lean 就绪')
			: leanState === 'starting'
				? 'Lean 启动中…'
				: leanState === 'failed'
					? `Lean 未连接${leanDetail === '' ? '' : `（${leanDetail}）`}`
					: '';
		/** 复制选区（没有选区就复制整篇）。 */
		/** 切换「文档注释渲染成 markdown」：只 dispatch 一个 effect，不重建编辑器。 */
		const toggleDocRender = useCallback(() => {
			const next = !docRender;
			setDocRender(next);
			const docMarkdown = docMarkdownRef.current;
			const editor = editorRef.current;
			if (docMarkdown === null || editor === null) return;
			try {
				editor.view.dispatch({ effects: docMarkdown.setEnabled.of(next) });
			} catch {
				/* 编辑器已销毁 */
			}
		}, [docRender]);

		const copySelection = useCallback(() => {
			const editor = editorRef.current;
			if (editor === null) return;
			const state = editor.view.state;
			const range = state.selection.main;
			const text = range.to > range.from
				? state.doc.sliceString(range.from, range.to)
				: state.doc.toString();
			const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
			if (clipboard?.writeText === undefined) {
				setChatNote('浏览器不给写剪贴板');
				return;
			}
			void Promise.resolve(clipboard.writeText(text)).then(
				() => setChatNote('已复制'),
				() => setChatNote('复制失败')
			);
		}, []);

		/** 选中内容（没有选区就连同整篇）→ 塞进对话草稿。 */
		const addSelectionToChat = useCallback(() => {
			const editor = editorRef.current;
			if (editor === null) return;
			const state = editor.view.state;
			const range = state.selection.main;
			const useSelection = range.to > range.from;
			const fromLine = state.doc.lineAt(useSelection ? range.from : 0).number;
			const toLine = state.doc.lineAt(useSelection ? range.to : state.doc.length).number;
			const text = useSelection
				? state.doc.sliceString(range.from, range.to)
				: state.doc.toString();
			if (text.trim() === '') {
				setChatNote('没有可添加的内容');
				return;
			}
			const payload = selectionBlock({ path, text, fromLine, toLine });
			const result = appendToComposer(ctx, scope?.sessionId, payload.text);
			if (result.ok) {
				setChatNote(`已添加 ${payload.label}`);
				return;
			}
			// 插入失败就退到剪贴板——至少别让用户白点一次。
			const reason = describeComposerFailure(result.reason);
			const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
			if (clipboard?.writeText === undefined) {
				setChatNote(reason);
				return;
			}
			void Promise.resolve(clipboard.writeText(payload.text)).then(
				() => setChatNote(`${reason}，已复制到剪贴板`),
				() => setChatNote(reason)
			);
		}, [ctx, path, scope]);

		// 提示三秒后自己消失。
		useEffect(() => {
			if (chatNote === '') return undefined;
			const timer = setTimeout(() => setChatNote(''), 3000);
			return () => clearTimeout(timer);
		}, [chatNote]);		// 菜单点外面/按 Esc/滚动就关。
		useEffect(() => {
			if (menu === null) return undefined;
			const close = () => setMenu(null);
			const onPointerDown = (event) => {
				const inside = menuRef.current !== null && menuRef.current.contains(event.target);
				if (!inside) close();
			};
			const onKeyDown = (event) => {
				if (event.key === 'Escape') close();
			};
			document.addEventListener('pointerdown', onPointerDown, true);
			document.addEventListener('keydown', onKeyDown, true);
			window.addEventListener('resize', close);
			return () => {
				document.removeEventListener('pointerdown', onPointerDown, true);
				document.removeEventListener('keydown', onKeyDown, true);
				window.removeEventListener('resize', close);
			};
		}, [menu]);

		/**
		 * 右键菜单。
		 *
		 * 用数组驱动而不是逐条写 JSX：条目还会长（Loogle、符号选择器在阶段 3），
		 * 而且顺序就是用户点开时看到的顺序，集中在一处好调。
		 */
		const menuItems = [
			{
				key: 'chat',
				label: menu !== null && menu.hasSelection ? '添加到对话（选中部分）' : '添加整篇到对话',
				run: addSelectionToChat
			},
			{
				key: 'copy',
				label: menu !== null && menu.hasSelection ? '复制选区' : '复制全文',
				run: copySelection
			},
			{
				key: 'definition',
				label: '跳转到定义',
				run: () => {
					void gotoDefinition(currentPosition());
				}
			},
			{ key: 'refs', label: '查找引用', run: () => { void findReferences(); } },
			{ key: 'suggest', label: '获取建议（Try this）', run: () => { void requestSuggestions(); } },
			{ key: 'outline', label: '文档大纲', run: () => { void loadOutline(); } },
			{ key: 'fold', label: '折叠所有证明', run: foldProofsNow },
			{ key: 'unfold', label: '展开全部', run: unfoldNow }
		];

		/** 右栏页签。 */
		const sideTabs = [
			{ key: 'goals', label: '目标' },
			{ key: 'outline', label: '大纲' },
			{ key: 'refs', label: '引用' },
			{ key: 'suggest', label: '建议' },
			{ key: 'settings', label: '设置' }
		];
		// 没挂上就用自带的极简目标面板顶上，两者都不行就显示原因。
		// 容器始终参与布局（占满右栏剩余高度），只是没就绪时透明：
		// 若用 display:none，React 挂载时量到 0 尺寸，infoview 的虚拟滚动会算错。
		const infoviewPanel = React.createElement('div', {
			className: 'dle-infoview',
			'data-ready': infoviewReady ? 'true' : 'false',
			ref: infoviewRef
		});
		/*
		 * 面板右上角的读数。它存在的唯一理由是「有数据却不显示」时能分辨原因：
		 * 服务端没发（诊断 0）／发了但没有 leanTags（完成 0 + 标签列表）／
		 * 有标签但派发失败（派发失败：…）。
		 */
		let sideNote = infoviewReady ? 'infoview' : '内置';
		if (serverNote !== '') sideNote += ` · ${serverNote}`;
		if (diagInfo !== null) {
			sideNote += ` · 诊断 ${diagInfo.total} · 完成 ${diagInfo.tagged}`;
			if (diagInfo.failure !== '') sideNote += ` · 派发失败：${diagInfo.failure}`;
			else if (diagInfo.total > 0 && diagInfo.tagged === 0 && diagInfo.sample !== null) {
				const tags = Array.isArray(diagInfo.sample.leanTags) ? diagInfo.sample.leanTags : [];
				sideNote += ` · 首个标签 [${tags.join(',')}] 静默=${diagInfo.sample.isSilent === true}`;
			}
		}
		const goalPanel = infoviewReady
			? null
			: goals !== null && goals.length > 0
				? React.createElement(
					'div',
					{ className: 'dle-goal' },
					React.createElement('div', { className: 'dle-goal-head' }, '目标'),
					...goals.map((text, index) => React.createElement(
						'pre',
						{ className: 'dle-goal-text', key: `goal-${index}` },
						text
					))
				)
				: React.createElement(
					'div',
					{ className: 'dle-side-hint' },
					infoviewNote !== ''
						? infoviewNote
						: leanState === 'ready'
							? '把光标放到某个 tactic / 项上，这里会显示目标与消息。'
							: 'Lean 语言服务器就绪后，这里会显示目标与消息。'
				);

		/*
		 * 页签内容区。infoview **不动**（它始终挂着、占满右栏剩余高度）——把别人的
		 * React 树按页签反复卸载重挂会丢滚动位置与内部状态，而且它一重挂就要重新
		 * 握手 `createRpcSession`。所以页签切换的只是它下面那块附加面板。
		 */
		const sideBody = (() => {
			if (sideTab === 'outline') {
				if (outline === null) {
					return React.createElement('div', { className: 'dle-side-hint' }, '还没有大纲。点这里加载：', React.createElement('button', {
						type: 'button',
						className: 'dle-side-action',
						onClick: () => { void loadOutline(); }
					}, '加载大纲'));
				}
				const rows = filterSymbols(outline, outlineQuery);
				return React.createElement(
					'div',
					{ className: 'dle-pane' },
					React.createElement('input', {
						className: 'dle-pane-input',
						type: 'search',
						placeholder: '筛选符号…',
						value: outlineQuery,
						onChange: (event) => setOutlineQuery(event.target.value)
					}),
					rows.length === 0
						? React.createElement('div', { className: 'dle-side-hint' }, '没有匹配的符号')
						: React.createElement(
							'div',
							{ className: 'dle-pane-list' },
							...rows.map((row, index) => React.createElement('button', {
								type: 'button',
								className: 'dle-pane-row',
								key: `sym-${index}`,
								'data-depth': row.depth,
								title: `${row.kind}${row.hint === '' ? '' : ` · ${row.hint}`}`,
								onClick: () => revealPosition({ line: row.line, character: 0 })
							}, row.label, React.createElement('span', { className: 'dle-pane-row-line' }, `L${row.line + 1}`)))
						)
				);
			}
			if (sideTab === 'refs') {
				if (refs === null) {
					return React.createElement('div', { className: 'dle-side-hint' }, '还没有引用。右键选「查找引用」。');
				}
				return React.createElement(
					'div',
					{ className: 'dle-pane' },
					React.createElement('div', { className: 'dle-pane-title' }, `${refs.title} · 本文件 ${refs.localCount} · 其它 ${refs.externalCount}`),
					refs.items.length === 0
						? React.createElement('div', { className: 'dle-side-hint' }, '没有找到引用')
						: React.createElement(
							'div',
							{ className: 'dle-pane-list' },
							...refs.items.map((item, index) => React.createElement('button', {
								type: 'button',
								className: 'dle-pane-row',
								key: `ref-${index}`,
								'data-local': item.local ? 'true' : 'false',
								onClick: () => gotoLocation(item)
							}, item.label))
						)
				);
			}
			if (sideTab === 'suggest') {
				if (suggestions === null) {
					return React.createElement('div', { className: 'dle-side-hint' }, '右键选「获取建议（Try this）」——把光标放到 `exact?` / `apply?` 那一行。');
				}
				if (suggestions.length === 0) {
					return React.createElement('div', { className: 'dle-side-hint' }, '这一行没有可用建议。');
				}
				return React.createElement(
					'div',
					{ className: 'dle-pane' },
					...suggestions.map((action, index) => React.createElement(
						'div',
						{ className: 'dle-suggest', key: `act-${index}` },
						React.createElement('div', { className: 'dle-suggest-title' }, action.title),
						React.createElement('button', {
							type: 'button',
							className: 'dle-side-action',
							onClick: () => applyAction(action)
						}, '应用')
					))
				);
			}
			if (sideTab === 'settings') {
				return React.createElement(
					'div',
					{ className: 'dle-pane' },
					...INFOVIEW_TOGGLES.map(([key, label]) => React.createElement(
						'label',
						{ className: 'dle-toggle', key },
						React.createElement('input', {
							type: 'checkbox',
							checked: infoviewConfig[key] === true,
							onChange: (event) => setConfigField(key, event.target.checked)
						}),
						label
					)),
					React.createElement('label', { className: 'dle-toggle dle-toggle-field' },
						'防抖（毫秒）',
						React.createElement('input', {
							type: 'number',
							min: 0,
							max: 5000,
							value: infoviewConfig.debounceTime,
							onChange: (event) => setConfigField('debounceTime', Number(event.target.value))
						})
					),
					React.createElement('label', { className: 'dle-toggle dle-toggle-field' },
						'期望类型',
						React.createElement('select', {
							value: infoviewConfig.expectedTypeVisibility,
							onChange: (event) => setConfigField('expectedTypeVisibility', event.target.value)
						}, ...EXPECTED_TYPE_VISIBILITY.map((value) => React.createElement('option', { key: value, value }, value)))
					),
					React.createElement('label', { className: 'dle-toggle dle-toggle-field' },
						'消息排序',
						React.createElement('select', {
							value: infoviewConfig.messageOrder,
							onChange: (event) => setConfigField('messageOrder', event.target.value)
						}, ...MESSAGE_ORDER.map((value) => React.createElement('option', { key: value, value }, value)))
					)
				);
			}
			return goalPanel;
		})();

		const sidePanel = React.createElement(
			'div',
			{ className: 'dle-side', 'data-open': sideOpen ? 'true' : 'false' },
			React.createElement(
				'div',
				{ className: 'dle-side-head' },
				React.createElement('span', null, '目标与消息'),
				React.createElement('span', { className: 'dle-side-note' }, sideNote)
			),
			React.createElement(
				'div',
				{ className: 'dle-side-tabs' },
				...sideTabs.map((tab) => React.createElement('button', {
					type: 'button',
					key: tab.key,
					className: 'dle-side-tab',
					'data-active': sideTab === tab.key ? 'true' : 'false',
					onClick: () => setSideTab(tab.key)
				}, tab.label))
			),
			infoviewNote === ''
				? null
				: React.createElement('div', { className: 'dle-side-error' }, infoviewNote),
			/*
			 * infoview 始终在最上面（goals 页签时它就是全部内容），附加面板在它下面。
			 * 顺序固定，切页签只换下面那块 —— 见上面 sideBody 的注释。
			 */
			infoviewPanel,
			sideTab === 'goals' ? null : sideBody,
			sideTab === 'goals' ? goalPanel : null
		);

		return React.createElement(
			'div',
			{ className: 'dle-host' },
			menu === null
				? null
				: React.createElement(
					'div',
					{
						className: 'dle-menu',
						ref: menuRef,
						style: { left: `${menu.left}px`, top: `${menu.top}px` }
					},
					...menuItems.map((item) => React.createElement('button', {
						type: 'button',
						key: item.key,
						className: 'dle-menu-item',
						onClick: () => {
							setMenu(null);
							item.run();
						}
					}, item.label))
				),
			React.createElement(
				'div',
				{ className: 'dle-body' },
				React.createElement('div', {
					className: 'dle-editor',
					ref: hostRef,
					style: { flex: '1 1 auto', minHeight: 0, overflow: 'hidden' }
				}),
				sidePanel
			),
			banner,
			React.createElement(
				'div',
				{ className: 'dle-status' },
				React.createElement('span', { className: 'dle-status-save' }, saveText),
				chatNote === ''
					? null
					: React.createElement('span', { className: 'dle-status-note' }, chatNote),
				foldNote === ''
					? null
					: React.createElement('span', { className: 'dle-status-note' }, foldNote),
				React.createElement('button', {
					type: 'button',
					className: 'dle-status-doc',
					'data-on': docRender ? 'true' : 'false',
					title: docRender ? '文档注释已渲染，点击显示源码' : '文档注释显示源码，点击渲染',
					onClick: toggleDocRender
				}, docRender ? '注释已渲染' : '注释源码'),
				React.createElement('button', {
					type: 'button',
					className: 'dle-status-side',
					title: sideOpen ? '收起右侧信息面板' : '展开右侧信息面板',
					onClick: () => setSideOpen((open) => !open)
				}, sideOpen ? '收起信息' : '信息'),
				leanText === ''
					? null
					: React.createElement(
						'span',
						{ className: 'dle-status-lean', 'data-state': leanState },
						leanText,
						React.createElement('button', {
							type: 'button',
							title: '重启 Lean 语言服务器',
							onClick: () => {
								void restartLsp();
							}
						}, '重启')
					)
			)
		);
	};
}

/**
 * ModuleLoader 的工厂入口。
 *
 * 返回一个 cordis 插件形状：`inject` 声明依赖 `betterSidebar`（宿主保证服务就绪后
 * 才激活本插件），`apply` 里做一次性注册。
 */
export function createClientBody(require) {
	const React = require('react');
	const view = createView(React);

	function apply(ctx) {
		insertStyle(typeof document === 'undefined' ? undefined : document);
		const service = ctx.betterSidebar;
		if (service === undefined || service === null || typeof service.registerFileViewer !== 'function') {
			console.warn('[dsh-lean4] 没找到 betterSidebar 服务，跳过注册（宿主版本过旧或未装 better-sidebar）');
			return;
		}
		ctx.effect(() =>
			service.registerFileViewer({
				id: VIEWER_ID,
				title: () => 'Lean 编辑器',
				exts: EXTENSIONS,
				priority: VIEWER_PRIORITY,
				fetchStrategy: 'fsRead',
				component: view
			})
		);
	}

	return { name: PLUGIN_ID, inject: ['betterSidebar'], apply };
}

/** 测试用：不经过 ModuleLoader 也能拿到组件与辅助函数。 */
export const __internal = { createView, saveStateOf, formatSize };
