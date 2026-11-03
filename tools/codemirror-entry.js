// CodeMirror 6 的「最小可编辑子集」入口，供 tools/build-codemirror.mjs 打包成
// 一个 IIFE 全局（globalThis.DCM），由浏览器半当依赖注入使用。
//
// 只导出真正用得到的部分：状态/视图/语言/命令/搜索，外加 tags 与 HighlightStyle，
// 这样 bundle 里不会混进任何 lang-* 语法包（语言由我们自己的 Lean 分词器提供）。

export {
	EditorState,
	Compartment,
	StateEffect,
	StateField,
	RangeSet,
	RangeSetBuilder
} from '@codemirror/state';

export {
	EditorView,
	Decoration,
	WidgetType,
	ViewPlugin,
	gutter,
	GutterMarker,
	keymap,
	lineNumbers,
	highlightActiveLine,
	highlightActiveLineGutter,
	drawSelection,
	dropCursor,
	rectangularSelection,
	hoverTooltip,
	tooltips
} from '@codemirror/view';

export {
	StreamLanguage,
	syntaxHighlighting,
	HighlightStyle,
	bracketMatching,
	indentOnInput,
	indentUnit,
	foldGutter,
	foldKeymap,
	foldAll,
	unfoldAll,
	codeFolding,
	foldService,
	foldable,
	foldEffect,
	foldedRanges
} from '@codemirror/language';

export {
	defaultKeymap,
	history,
	historyKeymap,
	indentWithTab,
	undo,
	redo,
	selectAll
} from '@codemirror/commands';

export { highlightSelectionMatches, searchKeymap } from '@codemirror/search';

export { linter, lintGutter, setDiagnostics, diagnosticCount, forceLinting } from '@codemirror/lint';

export {
	autocompletion,
	completionKeymap,
	startCompletion,
	closeCompletion,
	CompletionContext
} from '@codemirror/autocomplete';

export { tags } from '@lezer/highlight';
