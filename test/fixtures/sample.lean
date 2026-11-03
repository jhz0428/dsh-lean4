/-
  001.lean —— 一些简单的 Lean 4 示例
  仅依赖 Lean 4 核心库（不含 Mathlib），可直接用 `lean 001.lean` 检查。
-/

namespace Demo

/-! ## 1. 基本定义与求值 -/

def double (n : Nat) : Nat := 2 * n

#eval double 21            -- 42

def greet (name : String) : String := s!"Hello, {name}!"

#eval greet "Lean 4"       -- "Hello, Lean 4!"

/-! ## 2. 简单的定理与证明 -/

theorem add_zero' (n : Nat) : n + 0 = n := rfl

theorem two_add_two : 2 + 2 = 4 := rfl

theorem add_comm' (a b : Nat) : a + b = b + a := Nat.add_comm a b

/-- 线性算术可以直接交给 `omega`。 -/
theorem omega_example (a b : Nat) (h : a + 3 = b) : 3 ≤ b := by omega

/-- 可以用 `decide` 证明具体的数值命题。 -/
theorem concrete : 2 ^ 10 = 1024 := by decide

/-! ## 3. 自定义归纳类型 -/

inductive Tree (α : Type) where
  | leaf : Tree α
  | node : Tree α → α → Tree α → Tree α
  deriving Repr

namespace Tree

def size : Tree α → Nat
  | .leaf => 0
  | .node l _ r => l.size + r.size + 1

def depth : Tree α → Nat
  | .leaf => 0
  | .node l _ r => max l.depth r.depth + 1

/-- 中序遍历。 -/
def toList : Tree α → List α
  | .leaf => []
  | .node l x r => l.toList ++ [x] ++ r.toList

theorem size_leaf : size (.leaf : Tree α) = 0 := rfl

theorem toList_leaf : toList (.leaf : Tree α) = [] := rfl

end Tree

def sampleTree : Tree Nat :=
  .node (.node .leaf 1 .leaf) 2 (.node .leaf 3 .leaf)

#eval sampleTree
#eval sampleTree.size        -- 3
#eval sampleTree.depth       -- 2
#eval sampleTree.toList      -- [1, 2, 3]

/-! ## 4. 结构体与类型类 -/

structure Point where
  x : Float
  y : Float
  deriving Repr

def Point.add (p q : Point) : Point :=
  { x := p.x + q.x, y := p.y + q.y }

instance : Add Point := ⟨Point.add⟩

#eval ({ x := 1.0, y := 2.0 } : Point) + { x := 3.0, y := 4.0 }
-- { x := 4.000000, y := 6.000000 }

class Describable (α : Type) where
  describe : α → String

instance : Describable Nat where
  describe n := s!"自然数 {n}"

instance : Describable Bool where
  describe b := if b then "真" else "假"

#eval Describable.describe 7
#eval Describable.describe true

/-! ## 5. 递归函数与归纳证明 -/

def fib : Nat → Nat
  | 0 => 0
  | 1 => 1
  | n + 2 => fib (n + 1) + fib n

#eval (List.range 10).map fib   -- [0, 1, 1, 2, 3, 5, 8, 13, 21, 34]

theorem fib_zero : fib 0 = 0 := rfl
theorem fib_one : fib 1 = 1 := rfl
theorem fib_two : fib 2 = 1 := rfl
theorem fib_ten : fib 10 = 55 := by decide

def sumList : List Nat → Nat
  | [] => 0
  | x :: xs => x + sumList xs

#eval sumList [1, 2, 3, 4, 5]   -- 15

/-- 归纳法：列表拼接后的和等于两部分之和。 -/
theorem sumList_append (xs ys : List Nat) :
    sumList (xs ++ ys) = sumList xs + sumList ys := by
  induction xs with
  | nil => simp [sumList]
  | cons x xs ih => simp [sumList, ih, Nat.add_assoc]

/-- 归纳法：每个元素翻倍后求和等于原和的两倍。 -/
theorem sumList_map_double (xs : List Nat) :
    sumList (xs.map (2 * ·)) = 2 * sumList xs := by
  induction xs with
  | nil => simp [sumList]
  | cons x xs ih => simp [sumList, ih]; omega

/-!
## 6. LaTeX 公式（KaTeX）

行内公式 $a^2 + b^2 = c^2$ 会交给 KaTeX 渲染；写在行内代码里的 `$x^2$` 则原样保留。

勾股定理单独成行：

$$
a^2 + b^2 = c^2
$$

求和与积分：$\sum_{k=1}^{n} k = \frac{n(n+1)}{2}$，$\int_0^1 x^2\,\mathrm{d}x = \frac{1}{3}$，
极限 $\lim_{n \to \infty}\left(1 + \frac{1}{n}\right)^n = e$，以及欧拉恒等式 $e^{i\pi} + 1 = 0$。

矩阵乘法：

$$
\begin{pmatrix} a & b \\ c & d \end{pmatrix}
\begin{pmatrix} x \\ y \end{pmatrix}
=
\begin{pmatrix} ax + by \\ cx + dy \end{pmatrix}
$$

分段函数：

$$
f(n) = \begin{cases} 1 & n = 0 \\ n \cdot f(n-1) & n > 0 \end{cases}
$$

写坏的公式不会炸掉整段，只会在原位退成红字：$\frac{1}{$ 。
-/

end Demo
