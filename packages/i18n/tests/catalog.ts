export const messages = {
  greeting: "Hello, {name}",
  nested: { title: "Settings" },
  items: "{count, plural, one {# item} other {# items}}",
  "just-now": "Just now",
  "minutes-ago": "{minutes} minutes ago", "in-minutes": "in {minutes} minutes",
  "hours-ago": "{hours} hours ago", "in-hours": "in {hours} hours",
  "days-ago": "{days} days ago", "in-days": "in {days} days",
  "weeks-ago": "{weeks} weeks ago", "in-weeks": "in {weeks} weeks",
  "months-ago": "{months} months ago", "in-months": "in {months} months",
  "years-ago": "{years} years ago", "in-years": "in {years} years",
  "today-at": "Today at {time}", "yesterday-at": "Yesterday at {time}"
};
export const languages = [
  { code: "en", label: "English", messages },
  { code: "uz", label: "O'zbek", messages: { ...messages, greeting: "Salom, {name}" } }
] as const;
