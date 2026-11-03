// SPDX-License-Identifier: Apache-2.0
//
// 本文件**不属于**本项目的 MPL-2.0 覆盖范围，它按 Apache License 2.0 单独授权。
//
// 来源：vscode-lean4 —— https://github.com/leanprover/vscode-lean4
//       vscode-lean4/media/diagnostic-gutter-icons/goals-accomplished-checkmark-dark.svg
// Copyright the Lean Prover Community.
// License: Apache License, Version 2.0（全文见包根目录 LICENSE-APACHE-2.0）
//
// 为什么单独放一个文件：MPL-2.0 是**逐文件**的 copyleft（§1.7 Larger Work 允许把
// Covered Software 与其它文件里的非 Covered Software 组合分发，§3.3 允许 Larger Work
// 用自定义条款分发）。所以 Apache-2.0 的素材必须留在自己的文件里、并保留自己的许可声明，
// 不能和 MPL-2.0 的源码混在同一个文件里——混在一起就没法同时对两种条款都成立。
//
// 用法：`src/gutter-marks.js` 从这里取 `PROVEN_ICON`；构建时本文件排在它前面被内联进
// `lib/client.js`，那份产物因此是**多许可组件的聚合体**，见 THIRD-PARTY-NOTICES.md。

/*
 * 图标直接抄 vscode-lean4 的 `media/diagnostic-gutter-icons/goals-accomplished-checkmark-*.svg`
 * （16x16，实心路径，`currentColor` 让主题控制颜色）。
 *
 * 为什么不是「双对勾」：16px 内塞两个勾，每笔只有 1px 出头，两笔之间没有
 * 足够的留白，抗锯齿后必然糊成一个实心方块——这正是前一版看起来像方块的原因
 * （两条 stroke 的水平区间 0.5→8.2 与 7→14.7 还重叠了 1.2 单位）。
 * vscode 自己最后也选了单个对勾。
 */
export const CHECK_BODY = 'm 16.211845,3.8542521 -7.8050002,9.2139999 -0.728,-0.033 -3.087,-4.3949999'
	+ ' 0.754,-0.53 2.744,3.9069999 7.4190002,-8.7589999 z';
export const CHECK_DETAIL = 'm 7.8258448,9.0322521 4.3860002,-5.178 -0.703,-0.596 -4.2300002,4.994 z'
	+ ' m -1.55,0.403 0.548,0.7799999 -0.547,-0.7799999 z'
	+ ' m -1.617,1.9099999 0.547,0.78 -0.799,0.943 -0.728,-0.033 -3.087,-4.3949999'
	+ ' 0.754,-0.53 2.744,3.9069999 0.57,-0.672 z';

/** 内联 SVG。 */
export const PROVEN_ICON = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">'
	+ '<g transform="translate(-0.4018449,-0.16325205)" fill="currentColor" '
	+ 'fill-rule="evenodd" clip-rule="evenodd">'
	+ `<path d="${CHECK_BODY}"/><path d="${CHECK_DETAIL}"/></g></svg>`;
