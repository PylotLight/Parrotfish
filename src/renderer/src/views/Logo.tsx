import { useRef } from 'react'

const LINES = [
  "Squawk! Parrotfish here. Every part of me is swappable, so please don't swap my personality.",
  'Polly wants a lower voice to voice latency.',
  'I am a fish. I am also a parrot. Mostly I am a pipeline.'
]

/** The logo. Click it five times and it speaks (with whatever TTS the active profile uses). */
export function Logo() {
  const clicks = useRef<number[]>([])
  const said = useRef(0)
  const onClick = (): void => {
    const now = Date.now()
    clicks.current = [...clicks.current.filter((t) => now - t < 2000), now]
    if (clicks.current.length >= 5) {
      clicks.current = []
      const line = LINES[said.current++ % LINES.length]!
      void window.parrotfish.speak(line)
    }
  }
  return (
    <button className="logo" onClick={onClick} title="Parrotfish" aria-label="Parrotfish">
      <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true">
        <defs>
          <linearGradient id="pf-g" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#7ee2a8" />
            <stop offset="0.55" stopColor="#6ea8fe" />
            <stop offset="1" stopColor="#f2a65a" />
          </linearGradient>
        </defs>
        <path d="M4 16c4-7 11-10 17-8l3-3 1 5c2 2 3 4 3 6s-1 4-3 6l-1 5-3-3c-6 2-13-1-17-8z" fill="url(#pf-g)" />
        <path d="M24 13l5 2-5 2" fill="#f2a65a" />
        <circle cx="20" cy="14" r="1.6" fill="#0c0e11" />
        <path d="M9 16q3-2 6 0q-3 2-6 0" fill="#0c0e11" opacity="0.35" />
      </svg>
      <span>Parrotfish</span>
    </button>
  )
}
