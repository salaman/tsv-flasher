import {
  ArrowPathIcon,
  CheckCircleIcon,
  ClockIcon,
  MinusCircleIcon,
  XCircleIcon,
} from "@heroicons/react/20/solid";
import type { ReactNode } from "react";

export type Status = "pending" | "active" | "verified" | "failed" | "skipped";

const icons = {
  pending: ClockIcon,
  active: ArrowPathIcon,
  verified: CheckCircleIcon,
  failed: XCircleIcon,
  skipped: MinusCircleIcon,
};

/** Keep a text label alongside every icon so status never depends on color alone. */
export default function StatusIndicator({
  status,
  children,
}: {
  status: Status;
  children: ReactNode;
}) {
  const Icon = icons[status];

  return (
    <span className={`status-indicator status-${status}`}>
      <Icon aria-hidden="true" focusable="false" />
      <span>{children}</span>
    </span>
  );
}
