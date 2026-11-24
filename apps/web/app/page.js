import { GAME_RULES, OUTPUT } from '../../../packages/shared/rules.mjs';

export default function Home() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-[440px] flex-col gap-6 px-6 py-10">
      <header className="flex items-center justify-between gap-3">
        <span className="text-sm font-black tracking-wide">PASS THE MOVIE.</span>
        <span className="rounded-full bg-[#e6b84d] px-3 py-1 text-xs font-bold">DEV</span>
      </header>
      <h1 className="text-5xl font-black leading-[1.05] tracking-tight">
        Five friends.<br />Three seconds each.<br /><span className="text-[#b63222]">One movie.</span>
      </h1>
      <ol aria-label="Five scene positions" className="grid grid-cols-5 gap-2">
        {Array.from({ length: GAME_RULES.sceneCount }, (_, i) => (
          <li key={i} className="flex aspect-[9/16] flex-col items-center justify-center gap-1 rounded-xl border-2 border-[#24211e] bg-[#f4e9d9] text-center">
            <span className="text-2xl font-black">{i + 1}</span><span className="text-xs">{GAME_RULES.sceneSeconds}s</span>
          </li>
        ))}
      </ol>
      <p className="text-lg leading-relaxed">Record your scene, pass the last frame to a friend, and reveal the {OUTPUT.movieSeconds}-second film together.</p>
      <section className="rounded-2xl border border-[#24211e] p-4">
        <h2 className="font-bold">Development preview</h2>
        <p className="mt-1 text-sm">Movie creation and uploads are not connected yet. The camera compatibility experiment is separate.</p>
      </section>
    </main>
  );
}
