-- AddForeignKey
ALTER TABLE "watch_history" ADD CONSTRAINT "watch_history_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "media_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
