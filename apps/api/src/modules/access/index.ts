// Public surface consumed by other domains (registrations, sponsorships).
// AccessService exposes the cross-module capacity/validation entry points, all
// taking the caller's DbExecutor so they ride the caller's transaction:
//   validateAccessSelections, incrementAccessRegisteredCountTx,
//   decrementAccessRegisteredCountTx, incrementPaidCount, decrementPaidCount,
//   syncPaidCountDelta, getAlreadyCoveredAccessIds, handleCapacityReached.
export { AccessModule } from "./access.module";
export { AccessService } from "./access.service";
