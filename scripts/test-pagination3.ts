import { getAccessToken } from "../src/readai/auth.js";

async function main() {
  const token = await getAccessToken();
  const oldestMs = "1773154652460";
  
  const paramSets: Record<string, string>[] = [
    { start_time_ms_before: oldestMs },
    { start_time_ms_after: "0", start_time_ms_before: oldestMs },
    { before: oldestMs },
    { end_ms: oldestMs },
  ];

  for (const params of paramSets) {
    const url = new URL("https://api.read.ai/v1/meetings");
    url.searchParams.set("limit", "10");
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    const data = await res.json() as any;
    const meetings = data.data || data.meetings || [];
    if (meetings.length > 0) {
      const firstDate = new Date(meetings[0].start_time_ms).toISOString().slice(0, 10);
      const lastDate = new Date(meetings[meetings.length - 1].start_time_ms).toISOString().slice(0, 10);
      console.log(`${JSON.stringify(params)}: ${meetings.length} meetings (${lastDate} to ${firstDate})`);
    } else {
      console.log(`${JSON.stringify(params)}: ${res.status} - 0 or error`);
    }
  }
}

main();
