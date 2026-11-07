/** Compatibility path; production uses v2 values while v1 remains in contracts. */
export * from '@qqbot/contracts/task/types';
export type {
  LaneResultV2 as LaneResult,
  LaneSnapshotV2 as LaneSnapshot,
  TaskSnapshotV2 as TaskSnapshot,
  TaskHandleV2 as TaskHandle,
} from '@qqbot/contracts';
