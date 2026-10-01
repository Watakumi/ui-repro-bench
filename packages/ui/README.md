# @ui-bench/ui

試行をまたいで残る再利用コンポーネント。

`sandbox` とは別パッケージなので、アプリ側のファイルを import できない。
特定の画面専用のものがここに紛れ込むと、props を通さないと値を渡せないので、
規約ではなく構造で縛られる。

## 規約

- 1コンポーネント1ファイル。`src/Button.tsx` なら `export function Button(...)`
- `src/index.ts` から必ず re-export する
- props を取らないコンポーネントは置かない（画面専用ということ）
- 挙動を持つ部品（開閉・タブ・フォーカス移動）は Radix UI の primitive を土台にする
- 配色・文言は props か className で受け取る。特定の参照UIの値を焼き付けない

## 使う側

```tsx
import { Avatar, PillButton } from '@ui-bench/ui'
```
