import type { EngineAdapter } from '../../sync/SyncEngine';

/**
 * The contract between the player shell and a mount. A mount owns one
 * concrete player (YouTube iframe, HTMLMediaElement, ...) and reports two
 * things up: the EngineAdapter when its player becomes drivable (null again
 * on teardown - adapter presence IS readiness), and a human-readable reason
 * when playback dies. The shell owns everything else: engine lifecycle,
 * controls, HUD, and the failure card that a reported failure swaps in.
 */
export interface MountProps {
  onAdapter: (adapter: EngineAdapter | null) => void;
  onFailure: (reason: string) => void;
}
