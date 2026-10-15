const HOUR = 3600000;
function localParts(time, timeZone) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(time)).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
}
function localDate(time, zone) { const p = localParts(time, zone); return `${p.year}-${p.month}-${p.day}`; }
function addDays(date, days) { return new Date(Date.parse(`${date}T12:00:00Z`) + days * 24 * HOUR).toISOString().slice(0, 10); }
function atLocal(date, time, zone) {
  const desired = Date.parse(`${date}T${time}:00Z`);
  let utc = desired;
  for (let i = 0; i < 4; i++) {
    const p = localParts(utc, zone);
    const represented = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00Z`);
    const delta = desired - represented;
    utc += delta;
    if (delta === 0) break;
  }
  const p = localParts(utc, zone);
  if (`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}` !== `${date}T${time}`) throw new Error(`Local posting time does not exist: ${date} ${time} ${zone}`);
  return utc;
}
function pilotCalendar(settings, now, numPlatforms = 2, plan = null) {
  if (!plan && settings.pilot_counts) {
    plan = [];
    for (let round = 0; round < Math.max(...Object.values(settings.pilot_counts)); round++) {
      for (const [platform, count] of Object.entries(settings.pilot_counts)) if (round < count) plan.push({ platform });
    }
  }
  const date = settings.start_date || addDays(localDate(now, settings.pilot_timezone), 1);
  let slots = Array.from({ length: settings.pilot_days }, (_, day) => 
    settings.pilot_local_times.flatMap(time => {
      const t = atLocal(addDays(date, day), time, settings.pilot_timezone);
      return Array(numPlatforms).fill(t);
    })
  ).flat();
  if (plan) {
    const counts = {};
    slots = plan.map(item => {
      const n = counts[item.platform] || 0; counts[item.platform] = n + 1;
      return atLocal(addDays(date, Math.floor(n / settings.pilot_local_times.length)), settings.pilot_local_times[n % settings.pilot_local_times.length], settings.pilot_timezone);
    });
  }
  if (slots[0] <= now) throw new Error('Pilot start_date must put the first slot in the future');
  const endAt = atLocal(settings.end_date || addDays(date, 30), '23:59', settings.pilot_timezone);
  if (endAt <= slots.at(-1) + settings.observation_age_hours * HOUR) throw new Error('Campaign end_date must leave time to observe the pilot');
  return { slots, endAt };
}
function nextSlots(settings, after, count, endAt, numPlatforms = 3) {
  const slots = [];
  for (let day = 0; slots.length < count && day <= 370; day++) {
    const date = addDays(localDate(after, settings.pilot_timezone), day);
    for (const time of settings.pilot_local_times) {
      const slot = atLocal(date, time, settings.pilot_timezone);
      if (slot > after && slot <= endAt) {
        slots.push(...Array(numPlatforms).fill(slot));
      }
      if (slots.length >= count) break;
    }
    if (atLocal(date, '23:59', settings.pilot_timezone) > endAt) break;
  }
  return slots.slice(0, count);
}
module.exports = { HOUR, localDate, addDays, atLocal, pilotCalendar, nextSlots };
