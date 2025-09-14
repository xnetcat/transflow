import type { NextApiRequest, NextApiResponse } from "next";
import { ProgressTracker } from "../../../../src/web/ProgressTracker";
import { loadConfig } from "../../../../src/core/config";

const config = loadConfig("./transflow.config.json");
const tracker = new ProgressTracker(config);

// Start polling for progress updates
let isPolling = false;
if (!isPolling) {
  tracker.startPolling(1000); // Poll every second
  isPolling = true;

  // Cleanup old uploads every hour
  setInterval(() => {
    tracker.cleanup(60 * 60 * 1000); // 1 hour
  }, 60 * 60 * 1000);
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const { method } = req;

  switch (method) {
    case "GET":
      // Get progress for specific upload or all uploads
      const { uploadId } = req.query;

      if (uploadId && typeof uploadId === "string") {
        const progress = tracker.getProgress(uploadId);
        if (progress) {
          res.status(200).json(progress);
        } else {
          res.status(404).json({ error: "Upload not found" });
        }
      } else {
        // Return all active uploads (for admin/debugging)
        const allProgress = tracker.getAllProgress();
        res.status(200).json(allProgress);
      }
      break;

    case "POST":
      // Start tracking a new upload
      const {
        uploadId: newUploadId,
        templateId,
        files,
        branch = "main",
        userId,
      } = req.body;

      if (!newUploadId || !templateId || !files) {
        res.status(400).json({ error: "Missing required fields" });
        return;
      }

      const progress = tracker.startTracking(
        newUploadId,
        templateId,
        files,
        branch,
        userId
      );
      res.status(201).json(progress);
      break;

    default:
      res.setHeader("Allow", ["GET", "POST"]);
      res.status(405).end(`Method ${method} Not Allowed`);
  }
}


