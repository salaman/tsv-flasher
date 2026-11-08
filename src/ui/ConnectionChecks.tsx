import StatusIndicator, { type Status } from "./StatusIndicator";

const checks = [
  { id: "tools", title: "Connection tools", active: "Loading", complete: "Loaded" },
  {
    id: "programmer",
    title: "Programmer length and SHA-256",
    active: "Verifying",
    complete: "Verified",
  },
  { id: "identity", title: "Device HWID and OEM key", active: "Verifying", complete: "Verified" },
  { id: "upload", title: "Programmer upload to RAM", active: "Uploading", complete: "Loaded" },
  { id: "storage", title: "eMMC capacity and sector size", active: "Reading", complete: "Read" },
  {
    id: "gpt",
    title: "Both GPT copies and stock Android geometry",
    active: "Verifying",
    complete: "Verified",
  },
] as const;

type CheckId = (typeof checks)[number]["id"];

/** This stays in the light bundle so tool loading is visible before EDL imports finish. */
export default function ConnectionChecks(statuses: Partial<Record<CheckId, Status>>) {
  return (
    <ol className="checks" aria-live="polite">
      {checks.map((check) => {
        const status = statuses[check.id] ?? "pending";
        const labels = {
          failed: "Errored",
          verified: check.complete,
          active: check.active,
          pending: "Pending",
          skipped: "Skipped",
        };

        return (
          <li key={check.id}>
            <StatusIndicator status={status}>{labels[status]}</StatusIndicator>
            <span>{check.title}</span>
          </li>
        );
      })}
    </ol>
  );
}
