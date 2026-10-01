/**
 * 試行開始時にサンドボックスを戻すための初期状態。
 * run.ts が毎回これを sandbox/src/App.tsx に書き戻すので、
 * 前の試行の成果が次の試行に持ち越されない。
 *
 * ライト/ダークどちらで撮っても意味のある絵が出るようにしてある
 * （較正 `pnpm calibrate` がこのUIを基準画像に使うため）。
 */
export default function App() {
  return (
    <main className="flex min-h-full items-center justify-center bg-neutral-100 p-10 dark:bg-neutral-950">
      <section className="w-full max-w-md rounded-xl border border-neutral-300 bg-white p-6 text-neutral-900 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-100">
        <h1 className="text-lg font-semibold tracking-tight">ui-bench sandbox</h1>
        <p className="mt-2 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
          参照UIはまだ再現されていません。builder がこのファイルを書き換えます。
        </p>
        <dl className="mt-6 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-neutral-300 bg-neutral-300 text-sm dark:border-neutral-800 dark:bg-neutral-800">
          <div className="bg-white px-4 py-3 dark:bg-neutral-900">
            <dt className="text-neutral-500 dark:text-neutral-400">状態</dt>
            <dd className="mt-1 font-medium">未着手</dd>
          </div>
          <div className="bg-white px-4 py-3 dark:bg-neutral-900">
            <dt className="text-neutral-500 dark:text-neutral-400">ターン</dt>
            <dd className="mt-1 font-medium tabular-nums">0</dd>
          </div>
        </dl>
      </section>
    </main>
  )
}
