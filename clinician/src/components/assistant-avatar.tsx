"use client";
import { useEffect, useRef, useState } from "react";
import type { Mood } from "@/lib/assistant";
import "./assistant-avatar.css";

/**
 * The start page assistant as a small living character: it breathes, blinks, follows the pointer with its eyes,
 * glances around when idle, talks while its text is typed, smiles when hovered and bounces when poked.
 * All motion stops for users who prefer reduced motion.
 */
export function AssistantAvatar({ mood, talking, onPoke }: { mood: Mood; talking: boolean; onPoke: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [blink, setBlink] = useState(false);
  const [poked, setPoked] = useState(false);
  const [happy, setHappy] = useState(false);

  // Eyes follow the pointer; after a few idle seconds they glance around on their own.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let frame = 0;
    let idle: ReturnType<typeof setTimeout> | undefined;
    let glance: ReturnType<typeof setInterval> | undefined;
    const look = (x: number, y: number) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        el.style.setProperty("--px", `${x.toFixed(2)}px`);
        el.style.setProperty("--py", `${y.toFixed(2)}px`);
      });
    };
    const startIdle = () => {
      clearInterval(glance);
      glance = setInterval(() => {
        const a = Math.random() * Math.PI * 2;
        look(Math.cos(a) * 4, Math.sin(a) * 3);
      }, 1800);
    };
    const onMove = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height * 0.42);
      const d = Math.hypot(dx, dy) || 1;
      const reach = Math.min(1, d / 260);
      look((dx / d) * 5 * reach, (dy / d) * 4 * reach);
      clearInterval(glance);
      clearTimeout(idle);
      idle = setTimeout(startIdle, 3500);
    };
    window.addEventListener("pointermove", onMove);
    startIdle();
    return () => {
      window.removeEventListener("pointermove", onMove);
      cancelAnimationFrame(frame);
      clearTimeout(idle);
      clearInterval(glance);
    };
  }, []);

  // Blinks at a natural, irregular pace, sometimes twice.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(() => {
        setBlink(true);
        setTimeout(() => {
          setBlink(false);
          if (Math.random() < 0.25) setTimeout(() => { setBlink(true); setTimeout(() => setBlink(false), 120); }, 180);
        }, 130);
        schedule();
      }, 2200 + Math.random() * 3800);
    };
    schedule();
    return () => clearTimeout(timer);
  }, []);

  function poke() {
    setPoked(false);
    requestAnimationFrame(() => setPoked(true));
    onPoke();
  }

  return (
    <button
      ref={ref}
      type="button"
      className={`ai-avatar mood-${mood}${talking ? " is-talking" : ""}${blink ? " is-blinking" : ""}${poked ? " is-poked" : ""}${happy ? " is-happy" : ""}`}
      onClick={poke}
      onAnimationEnd={(e) => { if (e.animationName === "ai-squash") setPoked(false); }}
      onPointerEnter={() => setHappy(true)}
      onPointerLeave={() => setHappy(false)}
      onFocus={() => setHappy(true)}
      onBlur={() => setHappy(false)}
      aria-label="Assistenten. Tryck för att höra sammanfattningen igen."
    >
      <svg viewBox="0 0 200 200" aria-hidden="true">
        <defs>
          <radialGradient id="ai-body" cx="38%" cy="30%" r="75%">
            <stop offset="0%" stopColor="#ffd6ea" />
            <stop offset="45%" stopColor="#d9579a" />
            <stop offset="100%" stopColor="#6e2a55" />
          </radialGradient>
          <linearGradient id="ai-visor" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#2a1530" />
            <stop offset="100%" stopColor="#120914" />
          </linearGradient>
          <radialGradient id="ai-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="var(--ai-glow)" stopOpacity=".55" />
            <stop offset="100%" stopColor="var(--ai-glow)" stopOpacity="0" />
          </radialGradient>
        </defs>

        <circle className="ai-aura" cx="100" cy="104" r="96" fill="url(#ai-glow)" />
        <g className="ai-orbit">
          <circle cx="100" cy="14" r="3.2" />
          <circle cx="186" cy="110" r="2.4" />
          <circle cx="24" cy="150" r="2" />
        </g>
        <ellipse className="ai-shadow" cx="100" cy="188" rx="46" ry="7" />

        <g className="ai-body">
          <g className="ai-antenna">
            <path d="M100 44 C 100 34, 104 28, 108 22" />
            <circle className="ai-bulb" cx="109" cy="20" r="6" />
          </g>
          <path className="ai-shell" d="M100 42 C 150 42 170 70 170 108 C 170 148 142 170 100 170 C 58 170 30 148 30 108 C 30 70 50 42 100 42 Z" fill="url(#ai-body)" />
          <ellipse cx="72" cy="66" rx="22" ry="12" fill="#fff" opacity=".28" transform="rotate(-24 72 66)" />
          <rect className="ai-visor" x="50" y="78" width="100" height="58" rx="29" fill="url(#ai-visor)" />
          <g className="ai-brows">
            <path d="M68 89 Q 76 86 86 83" />
            <path d="M132 89 Q 124 86 114 83" />
          </g>
          <g className="ai-eyes">
            <g className="ai-eye" style={{ transformOrigin: "78px 105px" }}>
              <ellipse cx="78" cy="105" rx="10" ry="12" fill="#7ff5e6" />
              <circle className="ai-pupil" cx="78" cy="105" r="4.6" fill="#0c2f30" />
              <circle className="ai-pupil" cx="80" cy="101" r="1.8" fill="#fff" />
            </g>
            <g className="ai-eye" style={{ transformOrigin: "122px 105px" }}>
              <ellipse cx="122" cy="105" rx="10" ry="12" fill="#7ff5e6" />
              <circle className="ai-pupil" cx="122" cy="105" r="4.6" fill="#0c2f30" />
              <circle className="ai-pupil" cx="124" cy="101" r="1.8" fill="#fff" />
            </g>
            <g className="ai-smile-eyes">
              <path d="M68 107 Q 78 95 88 107" />
              <path d="M112 107 Q 122 95 132 107" />
            </g>
          </g>
          <path className="ai-mouth" d="M88 124 Q 100 132 112 124" />
          <ellipse className="ai-cheek" cx="58" cy="128" rx="8" ry="5" />
          <ellipse className="ai-cheek" cx="142" cy="128" rx="8" ry="5" />
        </g>
      </svg>
    </button>
  );
}
