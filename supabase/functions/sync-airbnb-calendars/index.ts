import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type Room = {
  id: number;
  name: string | null;
  airbnb_ical_url: string | null;
};

type AvailabilityRow = {
  room_id: number;
  date: string;
  status: "open" | "blocked" | "booked";
  reservation_id: string | null;
  created_at: string | null;
};

type SyncResult = {
  room_id: number;
  room_name: string | null;
  fetched: boolean;
  events_found: number;
  blocked_dates_found: number;
  inserted: number;
  updated_to_blocked: number;
  skipped_booked: number;
  already_blocked: number;
  errors: string[];
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

    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const { data: rooms, error: roomsError } = await supabase
      .from("rooms")
      .select("id, name, airbnb_ical_url")
      .not("airbnb_ical_url", "is", null);

    if (roomsError) {
      return jsonResponse(
        {
          error: "Failed to load rooms with Airbnb iCal URLs.",
          details: roomsError.message,
        },
        500,
      );
    }

    const roomList = (rooms ?? []) as Room[];

    if (roomList.length === 0) {
      return jsonResponse({
        success: true,
        message: "No rooms found with airbnb_ical_url configured.",
        results: [],
      });
    }

    const results: SyncResult[] = [];

    for (const room of roomList) {
      const result: SyncResult = {
        room_id: room.id,
        room_name: room.name,
        fetched: false,
        events_found: 0,
        blocked_dates_found: 0,
        inserted: 0,
        updated_to_blocked: 0,
        skipped_booked: 0,
        already_blocked: 0,
        errors: [],
      };

      try {
        if (!room.airbnb_ical_url) {
          result.errors.push("Room has no airbnb_ical_url.");
          results.push(result);
          continue;
        }

        const response = await fetch(room.airbnb_ical_url, {
          method: "GET",
          headers: {
            "User-Agent": "supabase-edge-function-airbnb-sync",
          },
        });

        if (!response.ok) {
          result.errors.push(
            `Failed to fetch iCal. HTTP ${response.status} ${response.statusText}`,
          );
          results.push(result);
          continue;
        }

        const icsText = await response.text();
        result.fetched = true;

        const { allDates, eventCount } = extractBlockedDatesFromIcs(icsText);
        result.events_found = eventCount;
        result.blocked_dates_found = allDates.length;

        if (allDates.length === 0) {
          results.push(result);
          continue;
        }

        const minDate = allDates[0];
        const maxDate = allDates[allDates.length - 1];

        const { data: existingRows, error: existingError } = await supabase
          .from("room_availability")
          .select("room_id, date, status, reservation_id, created_at")
          .eq("room_id", room.id)
          .gte("date", minDate)
          .lte("date", maxDate);

        if (existingError) {
          result.errors.push(
            `Failed to load existing availability: ${existingError.message}`,
          );
          results.push(result);
          continue;
        }

        const existingMap = new Map<string, AvailabilityRow>();

        for (const row of (existingRows ?? []) as AvailabilityRow[]) {
          existingMap.set(row.date, row);
        }

        const rowsToInsert: Array<{
          room_id: number;
          date: string;
          status: "blocked";
        }> = [];

        const rowsToUpdateToBlocked: string[] = [];

        for (const date of allDates) {
          const existing = existingMap.get(date);

          if (!existing) {
            rowsToInsert.push({
              room_id: room.id,
              date,
              status: "blocked",
            });
            continue;
          }

          if (existing.status === "booked") {
            result.skipped_booked += 1;
            continue;
          }

          if (existing.status === "blocked") {
            result.already_blocked += 1;
            continue;
          }

          if (existing.status === "open") {
            rowsToUpdateToBlocked.push(date);
            continue;
          }
        }

        if (rowsToInsert.length > 0) {
          const { error: insertError } = await supabase
            .from("room_availability")
            .insert(rowsToInsert);

          if (insertError) {
            result.errors.push(
              `Insert blocked rows failed: ${insertError.message}`,
            );
          } else {
            result.inserted = rowsToInsert.length;
          }
        }

        for (const date of rowsToUpdateToBlocked) {
          const { error: updateError } = await supabase
            .from("room_availability")
            .update({ status: "blocked" })
            .eq("room_id", room.id)
            .eq("date", date)
            .neq("status", "booked");

          if (updateError) {
            result.errors.push(
              `Failed updating ${date} to blocked: ${updateError.message}`,
            );
          } else {
            result.updated_to_blocked += 1;
          }
        }

        results.push(result);
      } catch (err) {
        result.errors.push(err instanceof Error ? err.message : String(err));
        results.push(result);
      }
    }

    return jsonResponse({
      success: true,
      message: "Manual Airbnb calendar sync finished.",
      results,
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
