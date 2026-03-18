/**
 * client.ts — Read AI API client
 *
 * Provides typed wrappers around the Read AI REST API for
 * listing meetings, fetching meeting details, and live data.
 */

import { getAccessToken } from "./auth.js";

const READAI_BASE_URL = "https://api.read.ai";

// ── Types ────────────────────────────────────────────────────────────────

export interface ReadAIMeeting {
  id: string;
  title?: string;
  start_time?: string;
  end_time?: string;
  duration_seconds?: number;
  participants?: string[];
  platform?: string;
  status?: string;
  [key: string]: unknown;
}

export interface ReadAIMeetingDetail {
  id: string;
  title?: string;
  start_time?: string;
  end_time?: string;
  duration_seconds?: number;
  participants?: ReadAIParticipant[];
  summary?: string;
  chapters?: ReadAIChapter[];
  action_items?: ReadAIActionItem[];
  questions?: ReadAIQuestion[];
  topics?: ReadAITopic[];
  transcript?: ReadAITranscriptEntry[];
  metrics?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ReadAIParticipant {
  name: string;
  email?: string;
  role?: string;
  talk_time_seconds?: number;
  [key: string]: unknown;
}

export interface ReadAIChapter {
  title: string;
  start_time?: string;
  end_time?: string;
  summary?: string;
  [key: string]: unknown;
}

export interface ReadAIActionItem {
  text: string;
  assignee?: string;
  due_date?: string;
  status?: string;
  [key: string]: unknown;
}

export interface ReadAIQuestion {
  text: string;
  asker?: string;
  answer?: string;
  answered?: boolean;
  [key: string]: unknown;
}

export interface ReadAITopic {
  name: string;
  duration_seconds?: number;
  [key: string]: unknown;
}

export interface ReadAITranscriptEntry {
  speaker?: string;
  text: string;
  start_time?: string;
  end_time?: string;
  [key: string]: unknown;
}

export interface ReadAILiveMeeting {
  id: string;
  status?: string;
  transcript?: ReadAITranscriptEntry[];
  chapters?: ReadAIChapter[];
  [key: string]: unknown;
}

export interface ListMeetingsParams {
  start_date?: string;
  end_date?: string;
  limit?: number;
  offset?: number;
}

export interface ListMeetingsResponse {
  meetings: ReadAIMeeting[];
  total?: number;
  limit?: number;
  offset?: number;
  [key: string]: unknown;
}

// ── Helpers ──────────────────────────────────────────────────────────────

async function readaiRequest<T>(path: string, params?: Record<string, string>): Promise<T> {
  const token = await getAccessToken();

  let url = `${READAI_BASE_URL}${path}`;
  if (params) {
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") {
        searchParams.set(key, value);
      }
    }
    const qs = searchParams.toString();
    if (qs) url += `?${qs}`;
  }

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Read AI API error ${res.status} on ${path}: ${text}`);
  }

  return (await res.json()) as T;
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * List meetings from Read AI.
 *
 * @param params - Optional filters: start_date, end_date (ISO), limit, offset
 */
export async function listMeetings(params?: ListMeetingsParams): Promise<ListMeetingsResponse> {
  const queryParams: Record<string, string> = {};

  if (params?.start_date) queryParams.start_date = params.start_date;
  if (params?.end_date) queryParams.end_date = params.end_date;
  if (params?.limit !== undefined) queryParams.limit = String(params.limit);
  if (params?.offset !== undefined) queryParams.offset = String(params.offset);

  const raw = await readaiRequest<Record<string, unknown>>("/v1/meetings", queryParams);

  // API returns { data: [...] } but we normalize to { meetings: [...] }
  const meetings = (raw.data ?? raw.meetings ?? []) as ReadAIMeeting[];
  return {
    meetings,
    total: raw.total as number | undefined,
    limit: raw.limit as number | undefined,
    offset: raw.offset as number | undefined,
  };
}

/**
 * Get full meeting details by ID.
 * Returns summary, chapters, action items, questions, topics, transcript, metrics.
 */
export async function getMeeting(id: string): Promise<ReadAIMeetingDetail> {
  return readaiRequest<ReadAIMeetingDetail>(`/v1/meetings/${encodeURIComponent(id)}`);
}

/**
 * Get live meeting data by ID.
 * Returns real-time transcript and chapter summaries for an in-progress meeting.
 */
export async function getLiveMeeting(id: string): Promise<ReadAILiveMeeting> {
  return readaiRequest<ReadAILiveMeeting>(`/v1/meetings/${encodeURIComponent(id)}/live`);
}
