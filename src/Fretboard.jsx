// ── The neck ─────────────────────────────────────────────────────────────
// Sideways view, ported from altered-trainer's Fretboard. Toolbox convention:
// frets left→right, strings stacked, LOW E AT THE BOTTOM, string-line weight
// tapering thick→thin to match a real neck.
//
// Row 0 is drawn at the top, so dots use cy = ry(5 - s) and string index 0
// (low E) lands at the bottom. Labels must therefore render STRINGS[r] — the
// mapped element — and NOT STRINGS[5-r], or the letters invert relative to the
// dots. MelodicMinorTrainer has that bug; this does not.

import { STRINGS, midiAt, pcAt, nameOf } from './theory.js';

const MARK_COLOR = { ok: '#2ed573', octave: '#fbbf24', wrong: '#ef4444', reveal: '#fb923c', ghost: '#6b6880' };

export default function Fretboard({
  lo = 0, hi = 12,
  dots = [],            // [{s,f,label?,color?}] — anything to draw
  marks = [],           // [{s,f,kind:'ok'|'octave'|'wrong'|'reveal'}]
  anchor = null,        // {s,f} — the "you are here" marker for nearest drills
  onTapCell = null,
  rowH = 36,
  fill = true,
  maxHeight = null,
  accent = '#fb923c',
}) {
  const FW = 36, RH = rowH, padL = 22, padT = 14, padB = 20, padR = 10;
  const nf = hi - lo + 1;
  const W = padL + nf * FW + padR, H = padT + 6 * RH + padB;
  const fx = f => padL + (f - lo + 0.5) * FW;
  const fxl = f => padL + (f - lo) * FW;
  const ry = r => padT + r * RH;
  // Low E thickest at the bottom, high e thinnest at the top.
  const STRING_W = [2.4, 2.0, 1.7, 1.4, 1.1, 0.8];
  const rDot = Math.max(7, Math.min(13, RH * 0.42));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={fill
      ? { display: 'block', margin: '0 auto', width: '100%', height: 'auto', ...(maxHeight ? { maxHeight } : {}), userSelect: 'none', WebkitUserSelect: 'none', touchAction: 'manipulation' }
      : { display: 'block', margin: '0 auto', width: 'auto', maxWidth: '100%', height: 260, userSelect: 'none', WebkitUserSelect: 'none' }}>

      {/* strings — index 0 (low E) at the bottom row, so row r holds string 5-r */}
      {Array.from({ length: 6 }, (_, r) => (
        <line key={'s' + r} x1={padL} y1={ry(r)} x2={padL + nf * FW} y2={ry(r)}
          stroke="#2a2840" strokeWidth={STRING_W[5 - r]} />
      ))}

      {/* frets, with a bright nut at 0 */}
      {Array.from({ length: nf + 1 }, (_, j) => {
        const f = lo + j, nut = f === 0;
        return <line key={'f' + j} x1={fxl(f)} y1={ry(0)} x2={fxl(f)} y2={ry(5)}
          stroke={nut ? '#cccccc' : '#2a2840'} strokeWidth={nut ? 3 : 1.4} />;
      })}

      {/* inlays */}
      {[3, 5, 7, 9, 15, 17, 19, 21].filter(f => f >= lo && f <= hi).map(f =>
        <circle key={'m' + f} cx={fx(f)} cy={ry(2) + RH / 2} r={2.6} fill="#2a2840" />)}
      {[12, 24].filter(f => f >= lo && f <= hi).map(f => (
        <g key={'m2' + f}>
          <circle cx={fx(f)} cy={ry(1) + RH / 2} r={2.6} fill="#2a2840" />
          <circle cx={fx(f)} cy={ry(3) + RH / 2} r={2.6} fill="#2a2840" />
        </g>
      ))}

      {/* string letters — STRINGS[r], never STRINGS[5-r] */}
      {STRINGS.map((s, r) => (
        <text key={'l' + r} x={6} y={ry(5 - r) + 3.5} fontSize={10} fill="#777" fontFamily="monospace">{s}</text>
      ))}

      {/* fret numbers */}
      {Array.from({ length: nf }, (_, j) => {
        const f = lo + j;
        if (f === 0) return null;
        const mark = [3, 5, 7, 9, 12, 15, 17, 19, 21].includes(f);
        return <text key={'n' + j} x={fx(f)} y={H - 7} fontSize={9}
          fill={mark ? '#888' : '#555'} textAnchor="middle" fontFamily="monospace">{f}</text>;
      })}

      {/* "you are here" — deliberately unlike an answer dot: hollow, dashed */}
      {anchor && (
        <circle cx={fx(anchor.f)} cy={ry(5 - anchor.s)} r={13} fill="none"
          stroke="#74b9ff" strokeWidth={2} strokeDasharray="3 3" pointerEvents="none" />
      )}

      {/* dots */}
      {dots.map((d, i) => {
        const cx = fx(d.f), cy = ry(5 - d.s), col = d.color || accent;
        return (
          <g key={'d' + i} pointerEvents="none">
            <circle cx={cx} cy={cy} r={rDot} fill={col} />
            {d.label && (
              <text x={cx} y={cy + 0.5} fontSize={d.label.length > 2 ? 7 : 9.5}
                fill="#17130c" textAnchor="middle" dominantBaseline="central" fontWeight="bold">{d.label}</text>
            )}
          </g>
        );
      })}

      {/* feedback, over the dots but under the tap grid */}
      {marks.map((m, i) => {
        const cx = fx(m.f), cy = ry(5 - m.s), col = MARK_COLOR[m.kind] || '#fff';
        if (m.kind === 'wrong') return (
          <g key={'m' + i} pointerEvents="none" stroke={col} strokeWidth={3} strokeLinecap="round">
            <line x1={cx - 8} y1={cy - 8} x2={cx + 8} y2={cy + 8} />
            <line x1={cx + 8} y1={cy - 8} x2={cx - 8} y2={cy + 8} />
          </g>
        );
        if (m.kind === 'ghost') return (
          <circle key={'m' + i} pointerEvents="none" cx={cx} cy={cy} r={rDot}
            fill="none" stroke={col} strokeWidth={1.6} strokeDasharray="3 3" opacity={0.85} />
        );
        return <circle key={'m' + i} pointerEvents="none" cx={cx} cy={cy} r={rDot} fill="none"
          stroke={col} strokeWidth={3} />;
      })}

      {/* Tap grid — LAST CHILD on purpose. SVG has no z-index, so paint order
          decides hit testing, and a transparent fill still receives events. It
          covers the whole window rather than just the dots, because most
          answers land on a fret with nothing drawn on it. Every node carries an
          inline cursor so it survives a global svg{pointer-events:none}. */}
      {onTapCell && (
        <g>
          {Array.from({ length: 6 }).flatMap((_, st) => Array.from({ length: nf }).map((_, j) => {
            const f = lo + j;
            return <rect key={`t${st}_${f}`} x={fxl(f)} y={ry(5 - st) - RH / 2} width={FW} height={RH}
              fill="transparent" style={{ cursor: 'pointer', touchAction: 'manipulation' }}
              onClick={() => onTapCell(st, f)} />;
          }))}
        </g>
      )}
    </svg>
  );
}
