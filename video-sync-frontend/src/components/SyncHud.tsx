import React from 'react';
import styled from '@emotion/styled';
import { color, font, radius } from '../theme';
import type { EngineStatus } from '../sync/SyncEngine';

const Hud = styled.div`
  position: absolute;
  top: 12px;
  left: 12px;
  z-index: 110;
  /* a scrim, not a surface: color.bg0 at 88% so the frame underneath still
     reads through. No opaque token can stand in - the translucency is the
     point, and theme.ts carries no bg0 alpha variant. */
  background: rgba(15, 13, 10, 0.88);
  border: 1px solid ${color.line};
  color: ${color.dim};
  font-family: ${font.mono};
  font-size: 11px;
  line-height: 1.5;
  padding: 10px 12px;
  border-radius: ${radius.sm};
  pointer-events: none;
  white-space: pre;
`;

const fmt = (n: number, digits = 0): string =>
  Number.isFinite(n) ? n.toFixed(digits) : '—';

/**
 * Debug overlay (toggled with backtick or ?debug=1). Instrumentation, not
 * chrome: everything shown comes straight from the engine's telemetry.
 */
export const SyncHud: React.FC<{ status: EngineStatus }> = ({ status }) => (
  <Hud data-testid="sync-hud">
    {[
      `state  ${status.ctrlState}${status.roomPlaying ? '' : ' (room paused)'}`,
      `drift  ${fmt(status.driftMs)}ms`,
      `θ      ${fmt(status.offsetMs, 1)}ms ±${fmt(status.uncertaintyMs, 1)}`,
      `rtt    ${fmt(status.rttMs)}ms`,
      `seq    ${status.seq}  seeks ${status.seeksIssued}`,
      `rate   ${status.fractionalRateOK ? 'fractional OK' : 'snapped (seek mode)'}`,
    ].join('\n')}
  </Hud>
);
