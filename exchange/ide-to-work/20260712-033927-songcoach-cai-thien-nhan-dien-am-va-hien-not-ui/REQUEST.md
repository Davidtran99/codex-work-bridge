# Yêu cầu: Cải thiện nhận diện âm guitar + hiển thị nốt trên web UI (songcoach)

## Bối cảnh dự án
**Guitar Trainer (songcoach)** — web app luyện guitar kiểu Yousician, chạy client-side (Web Audio API), server Flask chỉ serve static. Toàn bộ xử lý âm thanh chạy trong trình duyệt.

LƯU Ý: songcoach CHƯA đẩy lên GitHub (repo gốc là fork guitar-augmented-reality của người khác). Vì vậy source cốt lõi được KÈM trong `files/js/` của handoff này để đọc trực tiếp.

## Hiện trạng kỹ thuật (đã kiểm chứng trong code kèm theo)
- `pitch.js` — **PitchEngine**: nhận diện cao độ đơn âm bằng McLeod Pitch Method (MPM/NSDF) + parabolic interpolation. Có: 2-band gates (clarity/rms tách theo dải cao/thấp quanh 200Hz), ZCR timbre gate loại hiss/gõ, majority-vote stabilization (smoothFrames=3) + hold qua đuôi pluck (releaseFrames=6), hỗ trợ a4 hiệu chỉnh.
- `yamnet.js` — **GuitarGate** (tùy chọn): TensorFlow.js YAMNet phân biệt guitar vs giọng nói/nhiễu, chạy vài lần/giây trên buffer chung, degrade an toàn nếu model lỗi.
- `calibration.js` — hồ sơ đàn (~15s) tinh chỉnh ngưỡng theo cây đàn thật.
- `app.js` — vòng render: `updatePitchMeter(det)` hiển thị nốt live (`pitchNote` + cents + kim), gate scoring theo YAMNet, chế độ note/chord/explore.
- `fretboard.js` — vẽ cần đàn SVG + highlight ô nốt.
- `theory.js` — nhạc lý (nốt, MIDI, hợp âm).

## Mục tiêu cần cải thiện
### A. Nhận diện âm guitar tốt hơn
1. Giảm octave-error và nhầm lẫn ở dây trầm (E2/A2) qua mic laptop.
2. Ổn định hơn khi note decay (âm lượng tụt) mà không tăng latency.
3. Đề xuất (kèm lý do + tradeoff, KHÔNG chỉ mô tả tính năng):
   - Có nên thêm phát hiện đa âm (polyphonic) cho hợp âm không? Chi phí/độ khả thi client-side?
   - Cải thiện timbre gate / kết hợp YAMNet mượt hơn?
   - Tinh chỉnh tham số (clarityThreshold, rmsGate, smoothFrames, releaseFrames) theo bằng chứng đo được?

### B. Hiển thị nốt trên web UI tốt hơn
1. Nốt đang chơi hiển thị rõ ràng, phản hồi nhanh, ít giật/flicker.
2. Đề xuất cách hiển thị trực quan hơn: highlight ô trên fretboard theo nốt nhận được, lịch sử nốt vừa chơi, chỉ báo độ chính xác cents dễ đọc.
3. Giữ hiệu năng real-time (đang render qua requestAnimationFrame).

## Việc cần ChatGPT Work làm
1. Đọc source trong `files/js/` (pitch.js, yamnet.js, app.js, calibration.js, fretboard.js, theory.js).
2. Phân tích thuật toán hiện tại, chỉ ra điểm yếu cụ thể (dẫn dòng code).
3. Đề xuất cải tiến CÓ CHIỀU SÂU: nêu lý do, công nghệ, tradeoff, và các bước thực hiện cụ thể — kèm patch/diff hoặc pseudo-code nếu được.
4. Ưu tiên giải pháp chạy được client-side, không phá vỡ kiến trúc transport-only của PitchEngine.
5. Trả kết quả về `exchange/work-to-ide/` (RESPONSE.md + patch trong files/ nếu có).

## Ràng buộc
- Không cần chạy code (môi trường Work không có mic). Phân tích tĩnh + đề xuất là đủ.
- Giữ PitchEngine transport-only (không đụng DOM) để còn unit-test.
- Đề xuất phải thực tế, ưu tiên đo-bằng-chứng thay vì đoán.
