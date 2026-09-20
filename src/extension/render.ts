export function summarizeWorker(value: { id: string; status: string }): string {
  return `${value.id}  ${value.status}`;
}
