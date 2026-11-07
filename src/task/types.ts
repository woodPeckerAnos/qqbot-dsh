/** Compatibility path; production uses V3 snapshots while v1/v2 remain in contracts. */
export * from '@qqbot/contracts/task/types';
export type {
  LaneResultV3 as LaneResult,
  LaneSnapshotV3 as LaneSnapshot,
  TaskSnapshotV3 as TaskSnapshot,
  TaskHandleV3 as TaskHandle,
} from '@qqbot/contracts';
