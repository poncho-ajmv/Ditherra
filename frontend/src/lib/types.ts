export interface Palette {
  id: number;
  name: string;
  colors: string[];
  created_at?: number;
}

export interface Generation {
  id: number;
  prompt: string;
  system_prompt?: string;
  size: number;
  model?: string;
  sprite_type?: string;
  reference_id?: string;
  pixel_data?: number[][];
  iterations?: number;
  status: string;
  image_path?: string;
  created_at?: number;
  colors?: string[];
  logs?: LogEntry[];
}

export interface LogEntry {
  id: number;
  generation_id: number;
  step: string;
  message: string;
  created_at?: number;
}

/** Mirrors providers.status(). Deliberately has no field for the key itself. */
export interface ProviderStatus {
  name: string;
  kind: string;
  note: string;
  setup_url: string | null;
  setup_cmd: string | null;
  needs_key: boolean;
  key_env: string | null;
  configured: boolean;
  hint: string | null;
  locked: boolean;
  local: boolean;
  models: number;
  account_email?: string | null;
  account_plan?: string | null;
  error?: string | null;
}

export interface CodexAccount {
  configured: boolean;
  type?: string;
  email?: string | null;
  plan?: string | null;
}

export interface CodexLogin {
  type: "chatgpt";
  loginId: string;
  authUrl: string;
}

/** What providers.test_connection() reports. A code, not a sentence, so the
 *  diagnosis is worded in the user's language. */
export interface ProviderTest {
  code: "ok" | "no_models" | "refused" | "timeout" | "unauthorized" | "not_found"
      | "no_key" | "no_endpoint" | "error";
  models?: number;
  tool_models?: number;
  sample?: string[];
  detail?: string;
}

export interface Settings {
  system_prompt: string;
  models: string[];
  /** model id -> what it can do. Vision decides whether a reference is usable. */
  capabilities: Record<string, { vision: boolean; tools: boolean }>;
  default_model: string | null;
  image_models: string[];
  default_image_model: string | null;
  image_model_options: { id: string; available: boolean; reason: string }[];
  google_credential: "key" | "service account" | "antigravity" | null;
  sprite_types: Record<string, { label: string; has_tileset: boolean }>;
  /** Real tokens counted this process. reported=false when the provider gives none. */
  session_usage: { total: number; input: number; output: number; reported: boolean };
}
