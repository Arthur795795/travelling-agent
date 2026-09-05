import { applicationDatabase } from "../persistence/runtime.ts";
import { ShareRecordRepository } from "../persistence/repositories.ts";
import { SharingService } from "./service.ts";
import { sharingHttp } from "./http.ts";
import { loadFeatureFlags } from "../config/features.ts";
export const shareService = () =>
  new SharingService(new ShareRecordRepository(applicationDatabase()));
export const shareHttp = () =>
  sharingHttp(shareService(), () => loadFeatureFlags().sharing);
