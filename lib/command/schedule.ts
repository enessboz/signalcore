export type ScheduleKind = "once" | "daily" | "weekly" | "monthly";

export type ScheduleConfig = {
  run_at?: string | null;
  time_local?: string | null;
  days_of_week?: number[];
  day_of_month?: number | null;
  window_end_local?: string | null;
};

function getZonedParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const map = new Map(parts.map((part) => [part.type, part.value]));
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  return {
    year: Number(map.get("year")),
    month: Number(map.get("month")),
    day: Number(map.get("day")),
    weekday: weekdayMap[map.get("weekday") || "Sun"] ?? 0,
    hour: Number(map.get("hour")),
    minute: Number(map.get("minute")),
    second: Number(map.get("second")),
  };
}

function timeMatches(localTime: string | null | undefined, parts: ReturnType<typeof getZonedParts>) {
  if (!localTime) return false;
  const [hour, minute] = localTime.split(":").map(Number);
  return parts.hour === hour && parts.minute === minute;
}

function ranThisLocalSlot(
  lastRunAt: string | null | undefined,
  now: Date,
  timeZone: string,
) {
  if (!lastRunAt) return false;
  const last = getZonedParts(new Date(lastRunAt), timeZone);
  const current = getZonedParts(now, timeZone);
  return (
    last.year === current.year &&
    last.month === current.month &&
    last.day === current.day &&
    last.hour === current.hour &&
    last.minute === current.minute
  );
}

export function isScheduleDue(input: {
  scheduleKind: ScheduleKind;
  scheduleConfig: ScheduleConfig;
  timezone: string;
  lastRunAt?: string | null;
  now?: Date;
}) {
  const now = input.now || new Date();
  const { scheduleKind, scheduleConfig, timezone } = input;

  if (scheduleKind === "once") {
    if (!scheduleConfig.run_at || input.lastRunAt) return false;
    const runAt = new Date(scheduleConfig.run_at);
    if (Number.isNaN(runAt.getTime())) return false;
    return now.getTime() >= runAt.getTime();
  }

  const parts = getZonedParts(now, timezone);
  if (!timeMatches(scheduleConfig.time_local, parts)) return false;
  if (ranThisLocalSlot(input.lastRunAt, now, timezone)) return false;

  if (scheduleKind === "daily") return true;

  if (scheduleKind === "weekly") {
    return (scheduleConfig.days_of_week || []).includes(parts.weekday);
  }

  if (scheduleKind === "monthly") {
    return Number(scheduleConfig.day_of_month || 0) === parts.day;
  }

  return false;
}

export function scheduleDescription(
  kind: ScheduleKind,
  config: ScheduleConfig,
  timezone: string,
) {
  if (kind === "once") {
    return config.run_at ? `Once · ${config.run_at} · ${timezone}` : `Once · ${timezone}`;
  }
  if (kind === "daily") {
    return `Daily · ${config.time_local || "time not set"} · ${timezone}`;
  }
  if (kind === "weekly") {
    const days = (config.days_of_week || []).join(",");
    return `Weekly · days ${days || "not set"} · ${config.time_local || "time not set"} · ${timezone}`;
  }
  return `Monthly · day ${config.day_of_month || "not set"} · ${config.time_local || "time not set"} · ${timezone}`;
}
