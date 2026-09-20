export const commandRequiresText = (type: string): boolean =>
  ["prompt", "send", "steer"].includes(type);
