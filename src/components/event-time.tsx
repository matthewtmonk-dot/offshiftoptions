import { eventTime } from "@/lib/event-time";

export function EventTime({ value, asOf }: { value: Date; asOf?: Date }) {
  const { label, full } = eventTime(value, asOf);
  return <time dateTime={value.toISOString()} title={full} className="text-xs leading-relaxed text-zinc-400">{label}</time>;
}
