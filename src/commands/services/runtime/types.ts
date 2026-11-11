export type RuntimeKind = "clash" | "frp";

export type RuntimeTarget = {
  kind: RuntimeKind;
  /** The directory the runtime's files live in. */
  dir: string;
  /** Absolute path of the executable the feature looks for. */
  binary: string;
  installed: boolean;
};
