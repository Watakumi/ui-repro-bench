# lib

試行をまたいで残る再利用コンポーネント。

## 規約

- 1コンポーネント1ファイル。`Button.tsx` なら `export function Button(...)`
- `index.ts` から必ず re-export する
- props を取らないコンポーネントは置かない（画面専用ということなので App.tsx に書く）
- 挙動を持つ部品（開閉・タブ・フォーカス移動）は Radix UI の primitive を土台にする
- 配色は props か Tailwind のクラスで受け取る。特定の参照UIの色を焼き付けない

## 使う側

```tsx
import { Button, ArticleCard } from './lib'
```
