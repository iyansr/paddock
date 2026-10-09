// Remembers which agents are installed so New Session can offer them. Nothing here imports VS Code.
import { detectExecutables } from './detect';
import { detectedPresets, knownExecutables, resolvePresets, type Preset } from './presets';

export class AgentCatalog {
  private detected: Promise<Preset[] | undefined> | undefined;

  constructor(private readonly detect: (names: readonly string[]) => Promise<Set<string>> = detectExecutables) {}

  /** Starts a fresh lookup; New Session waits for it. Failure leaves the defaults in place. */
  refresh(): Promise<Preset[] | undefined> {
    this.detected = this.detect(knownExecutables()).then(
      found => detectedPresets(found),
      () => undefined,
    );
    return this.detected;
  }

  /** What New Session offers: the `paddock.agents` setting when set, else what is installed. */
  async presets(setting: unknown): Promise<Preset[]> {
    return resolvePresets(setting, await (this.detected ?? this.refresh()));
  }
}
