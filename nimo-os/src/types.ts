/**
 * Shared Type Definitions for NIMO OS
 */

export type FaceState =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'talking'
  | 'happy'
  | 'confused'
  | 'error'
  | 'music';

export interface LogEntry {
  id: string;
  timestamp: string;
  type: string;
  text: string;
  category: 'info' | 'voice' | 'intent' | 'ai' | 'action' | 'error';
}

export interface TimerInfo {
  id: string;
  duration: number; // in seconds
  remaining: number; // in seconds
  label: string;
  active: boolean;
}

export interface SystemStatus {
  cpuUsage: number;
  memoryUsage: number;
  temperature: number;
  decibelLevel: number;
  signalStrength: number;
  uptime: number; // in seconds
}

export type PersonalityTrait =
  | 'friendly'
  | 'sarcastic'
  | 'robotic'
  | 'dramatic'
  | 'quiet';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** One step the agent took (tool call trace for the activity timeline). */
export interface AgentStep {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  summary: string;
}

/** Rich cards the agent can surface (weather, research report, files...). */
export interface AgentCard {
  type: 'weather' | 'knowledge' | 'report' | 'files' | 'search';
  [key: string]: unknown;
}

export interface AgentResponse {
  ok: boolean;
  action: 'agent' | 'agent_clarify' | string;
  /** Text meant to be spoken aloud. */
  speak: string;
  text: string;
  state: FaceState;
  needsClarification: boolean;
  steps: AgentStep[];
  cards: AgentCard[];
  openUrl?: string;
  error?: string;
}

export interface InstalledApp {
  name: string;
  folder: string;
}

export interface FileHit {
  name: string;
  path: string;
  folder: string;
  sizeKB: number | null;
  modified: string | null;
}

export interface CommandResponse {
  ok: boolean;
  action: string;
  result: string;
  speak: string;
  state: FaceState;
  openUrl?: string;
  results?: SearchResult[];
  timer?: {
    duration: number;
    label: string;
  };
  stop?: boolean;
  error?: string;
}
