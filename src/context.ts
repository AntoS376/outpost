import type { Config } from './config.js';
import type { KiwixService } from './services/process.js';
import type { JobManager } from './services/jobs.js';
import type { AiProvider } from './services/ai.js';
import type { RagStore } from './services/rag.js';
import type { NotesStore } from './services/notes.js';
import type { ChatStore } from './services/chats.js';
import type { UserStore } from './services/users.js';
import type { UpdateChecker } from './services/updates.js';
import type { KolibriService } from './services/kolibri.js';
import type { PlaceIndex } from './services/places.js';
import type { Benchmark } from './services/benchmark.js';
import type { AppsService } from './services/apps.js';
import type { LocalTls } from './services/tls.js';
import type { KeepAwake } from './services/awake.js';
import type { PositionBoard } from './services/positions.js';
import type { SosBoard } from './services/sos.js';
import type { RoutingService } from './services/routing.js';
import type { DockerService } from './services/docker.js';
import type { GpuMonitor } from './services/gpu.js';
import type { InstallerService } from './services/installers.js';
import type { VoiceStore } from './services/voice.js';

export interface AppContext {
  cfg: Config;
  kiwix: KiwixService;
  jobs: JobManager;
  ai: AiProvider;
  rag: RagStore;
  users: UserStore;
  updates: UpdateChecker;
  /** One person's notes and saved conversations. */
  notesFor(user: string): NotesStore;
  chatsFor(user: string): ChatStore;
  kolibri: KolibriService;
  places: PlaceIndex;
  benchmark: Benchmark;
  apps: AppsService;
  tls: LocalTls;
  awake: KeepAwake;
  positions: PositionBoard;
  sos: SosBoard;
  routing: RoutingService;
  docker: DockerService;
  gpu: GpuMonitor;
  /** Kolibri, CyberChef and map fonts, installed from their pages. */
  installers: InstallerService;
  /** Voice messages on one shared channel. */
  voice: VoiceStore;
  /** Stops Outpost (the Shutdown button). Tests replace it. */
  requestShutdown: () => void;
  /** Restarts Outpost so new settings apply; false when it isn't running as a service. Tests replace it. */
  restart: () => boolean;
}
