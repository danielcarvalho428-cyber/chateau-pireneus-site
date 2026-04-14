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

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !serviceRoleKey) {
      return jsonResponse(
        {
          error:
            "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables.",
        },
        500,
      );
    }

    const url = new URL(req.url);

    let roomId: number | null = null;
    let daysAhead = 365;

    const roomIdFromQuery = url.searchParams.get("room_id");
    const daysAheadFromQuery = url.searchParams.get("days_ahead");

    if (daysAheadFromQuery) {
      const parsed = Number(daysAheadFromQuery);
      if (!Number.isNaN(parsed) && parsed > 0) {
        daysAhead = Math.min(parsed, 730);
      }
    }

    if (roomIdFromQuery) {
      const parsed = Number(roomIdFromQuery);
      if (!Number.isNaN(parsed)) {
        roomId = parsed;
      }
    }

    if (req.method === "POST" && roomId === null) {
      try {
        const body = await req.json().catch(() => null);
        if (body?.room_id != null) {
          const parsed = Number(body.room_id);
          if (!Number.isNaN(parsed)) {
            roomId = parsed;
          }
        }
        if (body?.days_ahead != null) {
          const parsed = Number(body.days_ahead);
          if (!Number.isNaN(parsed) && parsed > 0) {
            daysAhead = Math.min(parsed, 730);
          }
        }
      } catch {
      }
    }

    if (roomId === null) {
      return jsonResponse(
        {
          error:
            "Manual mode requires room_id. Example: ?room_id=1&days_ahead=365",
        },
        400,
      );
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const { data: room, error: roomError } = await supabase
      .from("rooms")
      .select("id, name, airbnb_ical_url")
      .eq("id", roomId)
      .single();

    if (roomError || !room) {
      return jsonResponse(
        {
          error: `Room ${roomId} not found.`,
          details: roomError?.message ?? null,
        },
        404,
      );
    }

    const typedRoom = room as Room;

    if (!typedRoom.airbnb_ical_url) {
      return jsonResponse(
        {
          error: `Room ${roomId} has no airbnb_ical_url configured.`,
        },
        400,
      );
    }

    const response = await fetch(typedRoom.airbnb_ical_url, {
      method: "GET",
      headers: {
        "User-Agent": "supabase-edge-function-airbnb-sync",
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      return jsonResponse(
        {
          error: "Failed to fetch Airbnb iCal.",
          status: response.status,
          statusText: response.statusText,
        },
        502,
      );
    }

    const icsText = await response.text();
    const { allDates, eventCount } = extractBlockedDatesFromIcs(icsText);

    const today = new Date();
    const todayDate = toDateOnlyUTC(
      new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())),
    );
    const endDate = toDateOnlyUTC(
      addDaysUTC(new Date(`${todayDate}T00:00:00.000Z`), daysAhead),
    );

    const filteredDates = allDates.filter((d) => d >= todayDate && d <= endDate);
    const filteredDateSet = new Set(filteredDates);
    const nowIso = new Date().toISOString();

    const { data: existingRows, error: existingError } = await supabase
      .from("room_availability")
      .select(
        "room_id, date, status, reservation_id, source, source_updated_at, created_at",
      )
      .eq("room_id", typedRoom.id)
      .gte("date", todayDate)
      .lte("date", endDate);

    if (existingError) {
      return jsonResponse(
        {
          error: "Failed to load existing room availability.",
          details: existingError.message,
        },
        500,
      );
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

    let skippedBooked = 0;
    let skippedHeld = 0;
    let alreadyBlockedManual = 0;
    let alreadyBlockedAirbnb = 0;

    for (const date of filteredDates) {
      const existing = existingMap.get(date);

      if (!existing) {
        rowsToInsert.push({
          room_id: typedRoom.id,
          date,
          status: "blocked",
          source: "airbnb",
          source_updated_at: nowIso,
        });
        continue;
      }

      if (existing.status === "booked") {
        skippedBooked += 1;
        continue;
      }

      if (existing.status === "held") {
        skippedHeld += 1;
        continue;
      }

      if (existing.status === "blocked") {
        if (existing.source === "airbnb") {
          datesToTouchAirbnb.push(date);
          alreadyBlockedAirbnb += 1;
        } else {
          alreadyBlockedManual += 1;
        }
        continue;
      }

      if (existing.status === "open") {
        datesToBlock.push(date);
      }
    }

    for (const [date, existing] of existingMap.entries()) {
      if (!filteredDateSet.has(date) && existing.source === "airbnb" && existing.status === "blocked") {
        datesToRelease.push(date);
      }
    }

    let inserted = 0;
    let updatedToBlocked = 0;
    let touchedAirbnb = 0;
    let releasedToOpen = 0;
    const errors: string[] = [];

    const insertChunks = chunkArray(rowsToInsert, 200);
    for (const chunk of insertChunks) {
      const { error } = await supabase.from("room_availability").insert(chunk);
      if (error) {
        errors.push(`Insert failed: ${error.message}`);
      } else {
        inserted += chunk.length;
      }
    }

    const blockChunks = chunkArray(datesToBlock, 200);
    for (const chunk of blockChunks) {
      const { error } = await supabase
        .from("room_availability")
        .update({
          status: "blocked",
          source: "airbnb",
          source_updated_at: nowIso,
        })
        .eq("room_id", typedRoom.id)
        .in("date", chunk)
        .eq("status", "open");

      if (error) {
        errors.push(`Block update failed: ${error.message}`);
      } else {
        updatedToBlocked += chunk.length;
      }
    }

    const touchChunks = chunkArray(datesToTouchAirbnb, 200);
    for (const chunk of touchChunks) {
      const { error } = await supabase
        .from("room_availability")
        .update({
          source_updated_at: nowIso,
        })
        .eq("room_id", typedRoom.id)
        .in("date", chunk)
        .eq("status", "blocked")
        .eq("source", "airbnb");

      if (error) {
        errors.push(`Airbnb touch failed: ${error.message}`);
      } else {
        touchedAirbnb += chunk.length;
      }
    }

    const releaseChunks = chunkArray(datesToRelease, 200);
    for (const chunk of releaseChunks) {
      const { error } = await supabase
        .from("room_availability")
        .update({
          status: "open",
          source: "manual",
          source_updated_at: nowIso,
        })
        .eq("room_id", typedRoom.id)
        .in("date", chunk)
        .eq("status", "blocked")
        .eq("source", "airbnb");

      if (error) {
        errors.push(`Release failed: ${error.message}`);
      } else {
        releasedToOpen += chunk.length;
      }
    }

    return jsonResponse({
      success: errors.length === 0,
      room_id: typedRoom.id,
      room_name: typedRoom.name,
      days_ahead: daysAhead,
      range_start: todayDate,
      range_end: endDate,
      events_found: eventCount,
      blocked_dates_found: filteredDates.length,
      inserted,
      updated_to_blocked: updatedToBlocked,
      touched_airbnb: touchedAirbnb,
      released_to_open: releasedToOpen,
      skipped_booked: skippedBooked,
      skipped_held: skippedHeld,
      already_blocked_manual: alreadyBlockedManual,
      already_blocked_airbnb: alreadyBlockedAirbnb,
      errors,
      message: "Manual Airbnb room sync finished.",
    });
  } catch (err) {
    return jsonResponse(
      {
        error: "Unexpected sync failure.",
        details: err instanceof Error ? err.message : String(err),
      },
      500,
    );
  }
});
