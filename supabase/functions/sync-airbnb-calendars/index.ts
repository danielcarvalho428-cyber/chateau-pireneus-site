import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type Room = {
  id: number;
  name: string | null;
  airbnb_ical_url: string | null;
};

type AvailabilityStatus = "open" | "blocked" | "booked" | "held";
type AvailabilitySource = "manual" | "website" | "airbnb";

type AvailabilityRow = {
  room_id: number;
  date: string;
  status: AvailabilityStatus;
  reservation_id: string | null;
  source: AvailabilitySource;
  source_updated_at: string | null;
  created_at: string | null;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function normalizeIcsText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function unfoldIcsLines(icsText: string): string[] {
  const rawLines = normalizeIcsText(icsText).split("\n");
  const unfolded: string[] = [];

  for (const line of rawLines) {
    if (!line) continue;

    if (
      unfolded.length > 0 &&
      (line.startsWith(" ") || line.startsWith("\t"))
    ) {
      unfolded[unfolded.length - 1] += line.slice(1);
    } else {
      unfolded.push(line);
    }
  }

  return unfolded;
}

function parseDateValue(value: string): Date | null {
  const clean = value.trim();

  if (/^\d{8}$/.test(clean)) {
    const year = Number(clean.slice(0, 4));
    const month = Number(clean.slice(4, 6));
    const day = Number(clean.slice(6, 8));
    return new Date(Date.UTC(year, month - 1, day));
  }

  const match = clean.match(
    /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/,
  );

  if (match) {
    const [, y, m, d, hh, mm, ss] = match;
    return new Date(
      Date.UTC(
        Number(y),
        Number(m) - 1,
        Number(d),
        Number(hh),
        Number(mm),
        Number(ss),
      ),
    );
  }

  return null;
}

function toDateOnlyUTC(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDaysUTC(date: Date, days: number): Date {
  const copy = new Date(date.getTime());
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function enumerateDatesExclusive(start: Date, endExclusive: Date): string[] {
  const dates: string[] = [];
  let cursor = new Date(start.getTime());

  while (cursor < endExclusive) {
    dates.push(toDateOnlyUTC(cursor));
    cursor = addDaysUTC(cursor, 1);
  }

  return dates;
}

function extractBlockedDatesFromIcs(icsText: string): {
  allDates: string[];
  eventCount: number;
} {
  const lines = unfoldIcsLines(icsText);

  let inEvent = false;
  let currentStart: Date | null = null;
  let currentEnd: Date | null = null;
  let eventCount = 0;
  const blockedDateSet = new Set<string>();

  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      inEvent = true;
      currentStart = null;
      currentEnd = null;
      continue;
    }

    if (line === "END:VEVENT") {
      if (inEvent && currentStart && currentEnd && currentStart < currentEnd) {
        const dates = enumerateDatesExclusive(currentStart, currentEnd);
        for (const d of dates) blockedDateSet.add(d);
        eventCount += 1;
      }

      inEvent = false;
      currentStart = null;
      currentEnd = null;
      continue;
    }

    if (!inEvent) continue;

    if (line.startsWith("DTSTART")) {
      const value = line.split(":").slice(1).join(":");
      currentStart = parseDateValue(value);
    }

    if (line.startsWith("DTEND")) {
      const value = line.split(":").slice(1).join(":");
      currentEnd = parseDateValue(value);
    }
  }

  return {
    allDates: Array.from(blockedDateSet).sort(),
    eventCount,
  };
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

type RoomSyncResult = {
  room_id: number;
  room_name: string | null;
  success: boolean;
  events_found: number;
  blocked_dates_found: number;
  inserted: number;
  updated_to_blocked: number;
  touched_airbnb: number;
  released_to_open: number;
  skipped_booked: number;
  skipped_held: number;
  already_blocked_manual: number;
  already_blocked_airbnb: number;
  errors: string[];
  error?: string;
};

async function syncRoom(
  supabase: ReturnType<typeof createClient>,
  room: Room,
  daysAhead: number,
): Promise<RoomSyncResult> {
  const base: Omit<RoomSyncResult, "success" | "error"> = {
    room_id: room.id,
    room_name: room.name,
    events_found: 0,
    blocked_dates_found: 0,
    inserted: 0,
    updated_to_blocked: 0,
    touched_airbnb: 0,
    released_to_open: 0,
    skipped_booked: 0,
    skipped_held: 0,
    already_blocked_manual: 0,
    already_blocked_airbnb: 0,
    errors: [],
  };

  if (!room.airbnb_ical_url) {
    return { ...base, success: false, error: `Room ${room.id} has no airbnb_ical_url.` };
  }

  let icsText: string;
  try {
    const response = await fetch(room.airbnb_ical_url, {
      method: "GET",
      headers: { "User-Agent": "supabase-edge-function-airbnb-sync" },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      return {
        ...base,
        success: false,
        error: `Failed to fetch iCal for room ${room.id}: HTTP ${response.status}`,
      };
    }

    icsText = await response.text();
  } catch (err) {
    return {
      ...base,
      success: false,
      error: `Fetch error for room ${room.id}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const { allDates, eventCount } = extractBlockedDatesFromIcs(icsText);
  base.events_found = eventCount;

  const today = new Date();
  const todayDate = toDateOnlyUTC(
    new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())),
  );
  const endDate = toDateOnlyUTC(
    addDaysUTC(new Date(`${todayDate}T00:00:00.000Z`), daysAhead),
  );

  const filteredDates = allDates.filter((d) => d >= todayDate && d <= endDate);
  const filteredDateSet = new Set(filteredDates);
  base.blocked_dates_found = filteredDates.length;
  const nowIso = new Date().toISOString();

  const { data: existingRows, error: existingError } = await supabase
    .from("room_availability")
    .select("room_id, date, status, reservation_id, source, source_updated_at, created_at")
    .eq("room_id", room.id)
    .gte("date", todayDate)
    .lte("date", endDate);

  if (existingError) {
    return {
      ...base,
      success: false,
      error: `Failed to load availability for room ${room.id}: ${existingError.message}`,
    };
  }

  const existingMap = new Map<string, AvailabilityRow>();
  for (const row of (existingRows ?? []) as AvailabilityRow[]) {
    existingMap.set(row.date, row);
  }

  const rowsToInsert: Array<{
    room_id: number;
    date: string;
    status: "blocked";
    source: "airbnb";
    source_updated_at: string;
  }> = [];

  const datesToBlock: string[] = [];
  const datesToTouchAirbnb: string[] = [];
  const datesToRelease: string[] = [];

  for (const date of filteredDates) {
    const existing = existingMap.get(date);

    if (!existing) {
      rowsToInsert.push({ room_id: room.id, date, status: "blocked", source: "airbnb", source_updated_at: nowIso });
      continue;
    }

    if (existing.status === "booked") { base.skipped_booked += 1; continue; }
    if (existing.status === "held")   { base.skipped_held   += 1; continue; }

    if (existing.status === "blocked") {
      if (existing.source === "airbnb") { datesToTouchAirbnb.push(date); base.already_blocked_airbnb += 1; }
      else { base.already_blocked_manual += 1; }
      continue;
    }

    if (existing.status === "open") datesToBlock.push(date);
  }

  for (const [date, existing] of existingMap.entries()) {
    if (!filteredDateSet.has(date) && existing.source === "airbnb" && existing.status === "blocked") {
      datesToRelease.push(date);
    }
  }

  for (const chunk of chunkArray(rowsToInsert, 200)) {
    const { error } = await supabase.from("room_availability").insert(chunk);
    if (error) base.errors.push(`Insert failed: ${error.message}`);
    else base.inserted += chunk.length;
  }

  for (const chunk of chunkArray(datesToBlock, 200)) {
    const { error } = await supabase
      .from("room_availability")
      .update({ status: "blocked", source: "airbnb", source_updated_at: nowIso })
      .eq("room_id", room.id)
      .in("date", chunk)
      .eq("status", "open");
    if (error) base.errors.push(`Block update failed: ${error.message}`);
    else base.updated_to_blocked += chunk.length;
  }

  for (const chunk of chunkArray(datesToTouchAirbnb, 200)) {
    const { error } = await supabase
      .from("room_availability")
      .update({ source_updated_at: nowIso })
      .eq("room_id", room.id)
      .in("date", chunk)
      .eq("status", "blocked")
      .eq("source", "airbnb");
    if (error) base.errors.push(`Airbnb touch failed: ${error.message}`);
    else base.touched_airbnb += chunk.length;
  }

  for (const chunk of chunkArray(datesToRelease, 200)) {
    const { error } = await supabase
      .from("room_availability")
      .update({ status: "open", source: "manual", source_updated_at: nowIso })
      .eq("room_id", room.id)
      .in("date", chunk)
      .eq("status", "blocked")
      .eq("source", "airbnb");
    if (error) base.errors.push(`Release failed: ${error.message}`);
    else base.released_to_open += chunk.length;
  }

  return { ...base, success: base.errors.length === 0 };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !serviceRoleKey) {
      return jsonResponse({ error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY." }, 500);
    }

    const url = new URL(req.url);
    let roomId: number | null = null;
    let daysAhead = 365;

    const roomIdFromQuery = url.searchParams.get("room_id");
    const daysAheadFromQuery = url.searchParams.get("days_ahead");

    if (daysAheadFromQuery) {
      const parsed = Number(daysAheadFromQuery);
      if (!Number.isNaN(parsed) && parsed > 0) daysAhead = Math.min(parsed, 730);
    }

    if (roomIdFromQuery) {
      const parsed = Number(roomIdFromQuery);
      if (!Number.isNaN(parsed)) roomId = parsed;
    }

    if (req.method === "POST" && roomId === null) {
      try {
        const body = await req.json().catch(() => null);
        if (body?.room_id != null) {
          const parsed = Number(body.room_id);
          if (!Number.isNaN(parsed)) roomId = parsed;
        }
        if (body?.days_ahead != null) {
          const parsed = Number(body.days_ahead);
          if (!Number.isNaN(parsed) && parsed > 0) daysAhead = Math.min(parsed, 730);
        }
      } catch { /* ignore */ }
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey);

    // ── Single room mode ───────────────────────────────────────────
    if (roomId !== null) {
      const { data: room, error: roomError } = await supabase
        .from("rooms")
        .select("id, name, airbnb_ical_url")
        .eq("id", roomId)
        .single();

      if (roomError || !room) {
        return jsonResponse({ error: `Room ${roomId} not found.`, details: roomError?.message ?? null }, 404);
      }

      const result = await syncRoom(supabase, room as Room, daysAhead);
      return jsonResponse({ ...result, days_ahead: daysAhead, message: "Room sync finished." });
    }

    // ── All-rooms mode (used by cron) ─────────────────────────────
    const { data: allRooms, error: allRoomsError } = await supabase
      .from("rooms")
      .select("id, name, airbnb_ical_url")
      .not("airbnb_ical_url", "is", null)
      .eq("active", true)
      .order("id", { ascending: true });

    if (allRoomsError) {
      return jsonResponse({ error: "Failed to load rooms.", details: allRoomsError.message }, 500);
    }

    if (!allRooms || allRooms.length === 0) {
      return jsonResponse({ success: true, message: "No rooms with Airbnb iCal URLs found.", rooms: [] });
    }

    const results: RoomSyncResult[] = [];
    for (const room of allRooms as Room[]) {
      const result = await syncRoom(supabase, room, daysAhead);
      results.push(result);
    }

    const allErrors = results.flatMap((r) => r.errors);
    return jsonResponse({
      success: allErrors.length === 0,
      days_ahead: daysAhead,
      rooms_synced: results.length,
      rooms: results,
      message: "All-rooms Airbnb sync finished.",
    });
  } catch (err) {
    return jsonResponse(
      { error: "Unexpected sync failure.", details: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
});
