# Kế hoạch phát triển ITClub Arena

Tài liệu này ghi lại các hạng mục phát triển tiếp theo của ITClub Arena, dựa trên mã nguồn hiện tại. Mục tiêu là hoàn thiện luồng thi AI dạng Kaggle, quản trị vòng đời bài tập rõ ràng hơn và cải thiện trang hồ sơ người dùng.

> **Trạng thái 06/11/2026:** Toàn bộ hạng mục P0 và P1 trong kế hoạch này đã
> được triển khai ở mã nguồn local. Luồng end-to-end upload dataset → download
> file công khai → chấm CSV → leaderboard → archive → unarchive → permanent
> delete đã pass; 48/48 test của CSV Judge và production build frontend đều
> pass. Phần “Hiện trạng” bên dưới được giữ lại như mốc mô tả trước triển khai.

## 1. Hiện trạng

### Bài AI Tracks dạng CSV

Hệ thống hiện đã hỗ trợ:

- Admin tạo bài CSV và tải lên `ground_truth.csv` riêng tư.
- Admin có thể tải lên `sample_submission.csv`.
- Người dùng tải sample submission từ trang chi tiết bài.
- Người dùng nộp file CSV; CSV Judge kiểm tra cấu trúc, căn hàng theo ID và tính điểm theo metric đã cấu hình.
- Dữ liệu chấm được lưu trong Docker volume `csvdata`; `ground_truth.csv` không được trả về API công khai.

Hệ thống chưa hỗ trợ đầy đủ quy trình giống Kaggle:

- Chưa có nơi để admin tải lên train/test dataset.
- Chưa có danh sách file dữ liệu công khai của từng bài.
- Chưa có API và giao diện tải dataset từ trang bài.
- Upload phía admin đang dùng memory storage và giới hạn 10 MB, chưa phù hợp với dataset lớn.

### Quản trị bài tập

- Nút Archive hiện chỉ đặt `active=false` và giữ nguyên lịch sử submission.
- Danh sách admin vẫn nhận cả bài active và archived.
- Chưa có thao tác Unarchive riêng.
- Chưa có thao tác xóa vĩnh viễn bài và toàn bộ submission liên quan.
- Bảng `submissions` hiện lưu `problem_slug` nhưng không có khóa ngoại tới bảng `problems`, nên việc xóa phải được xử lý tường minh trong transaction.

### Profile

- Profile đã có thông tin thành viên, thống kê, avatar và form chỉnh sửa account.
- Khối Profile Overview đang bị chia cột/bóp chiều ngang, làm nội dung thiếu thoáng và mất cân đối.

## 2. Mục tiêu phát triển

### P0 — Hoàn thiện AI Tracks theo mô hình Kaggle

#### 2.1. Mô hình file của một challenge

Phân tách rõ file công khai và file riêng tư:

```text
csv-problems/<slug>/
├── config.json              # riêng tư, dùng cho judge
├── ground_truth.csv         # riêng tư, tuyệt đối không cho tải
├── train.csv                # công khai, tùy chọn
├── test.csv                 # công khai, nên có
├── sample_submission.csv    # công khai, nên có
└── data.zip                 # công khai, tùy chọn
```

Quy ước:

- `ground_truth.csv` và `config.json` không xuất hiện trong metadata công khai và không được phục vụ bởi download route.
- Chỉ các tên file nằm trong allowlist mới được tải xuống.
- Không dùng tên file do client cung cấp làm đường dẫn lưu trực tiếp.
- Khi chỉnh sửa bài, file cũ được giữ nguyên nếu admin không tải file thay thế.

#### 2.2. Admin UI

Trong form tạo/chỉnh sửa bài CSV, bổ sung:

- Upload train dataset, tùy chọn.
- Upload test dataset.
- Upload sample submission.
- Upload private ground truth.
- Tùy chọn upload `data.zip` nếu muốn phát hành một gói dữ liệu duy nhất.
- Hiển thị tên, kích thước và trạng thái của từng file đang tồn tại.
- Cho phép thay thế hoặc xóa từng file công khai mà không ảnh hưởng ground truth.
- Giải thích rõ file nào công khai và file nào chỉ dùng để chấm.

#### 2.3. API và lưu trữ

Đề xuất API:

- `GET /api/problems/:slug/data-files`: trả metadata các file công khai.
- `GET /api/problems/:slug/data/:fileKey`: stream file theo khóa allowlist như `train`, `test`, `sample_submission` hoặc `bundle`.
- Giữ tương thích route `GET /api/problems/:slug/sample-submission.csv` hiện tại, hoặc redirect nội bộ sang route mới.
- Các route admin tạo/chỉnh sửa nhận thêm những field file tương ứng.

Yêu cầu kỹ thuật:

- Chuyển upload dataset lớn từ `multer.memoryStorage()` sang disk storage/streaming tạm thời.
- Kiểm tra phần mở rộng, MIME ở mức hợp lý, kích thước và tên file.
- Ghi file theo cơ chế atomic replace để judge không đọc file đang ghi dở.
- Xóa file tạm khi request lỗi.
- Thiết lập giới hạn dung lượng theo từng file và tổng dung lượng một challenge; giá trị ban đầu đề xuất là 100 MB/challenge, có thể cấu hình bằng biến môi trường.
- Kiểm tra dung lượng đĩa trước khi nhận file lớn; VPS hiện có ổ đĩa nhỏ nên cần theo dõi và cảnh báo.
- Không cho web server truy cập trực tiếp toàn bộ volume qua static directory; mọi download phải đi qua route đã kiểm soát.

#### 2.4. Giao diện người thi

Trong tab Description của bài CSV, thêm khối **Competition data**:

- Danh sách file, loại file và dung lượng.
- Nút tải từng file.
- Nút tải `data.zip` nếu challenge có cung cấp.
- Hướng dẫn ngắn: train dùng để huấn luyện, test dùng để dự đoán, sample submission mô tả đúng schema cần nộp.
- Trạng thái trống rõ ràng nếu bài cũ chưa có dataset công khai.

#### 2.5. Tiêu chí nghiệm thu

- Người dùng tải được train/test/sample từ trang bài nhưng không thể tải ground truth hoặc config bằng cách sửa URL.
- File submission theo sample được CSV Judge nhận và chấm bình thường.
- Chỉnh sửa metadata bài không làm mất dataset cũ.
- Thay thế dataset không tạo file dở hoặc file tạm tồn đọng.
- File vượt giới hạn bị từ chối bằng thông báo dễ hiểu.
- Các bài CSV cũ vẫn hoạt động và tải được sample submission như trước.

### P0 — Leaderboard riêng cho từng bài CSV Judge

Điểm CSV Judge hiện được lưu dưới dạng **giá trị metric gốc**, không phải điểm đã
normalize về một thang chung. Ví dụ, RMSE là loss càng thấp càng tốt; F1 và
Macro F1 thường nằm trong `[0, 1]` và càng cao càng tốt. Leaderboard của một
bài phải sử dụng trực tiếp metric đó giống mô hình Kaggle.

#### 2.6. Quy tắc xếp hạng

- Mỗi thành viên chỉ xuất hiện một lần với submission hợp lệ tốt nhất của họ.
- Chỉ xét submission có `status='accepted'` và `score` khác null.
- Loại tài khoản admin khỏi leaderboard.
- Metric có `greater_is_better=true` được sắp xếp giảm dần.
- Metric có `greater_is_better=false` được sắp xếp tăng dần.
- Nếu hai thành viên bằng điểm, người đạt điểm đó sớm hơn đứng trên.
- Hiển thị tổng số lần submit của từng người để phản ánh quá trình thử nghiệm.
- Tiếp tục lưu raw metric trong `submissions.score`; không nhân 100 hoặc ghi đè
  bằng một công thức normalize.

Các metric có chiều điển hình:

- Higher is better: Accuracy, F1, Macro F1, Precision, Recall, R², MRR, MAP,
  Recall@K, NDCG@K, SacreBLEU và ChrF.
- Lower is better: Log Loss, Hamming Loss, MAE, MSE, RMSE, MAPE và SMAPE.
- Không hard-code danh sách này ở frontend; API phải trả `greater_is_better`
  từ cấu hình metric đã được CSV Judge kiểm tra.

#### 2.7. Backend/API

- Tạo endpoint riêng, đề xuất `GET /api/problems/:slug/leaderboard`.
- Endpoint chỉ áp dụng cho bài `kind='csv'`; Function Only tiếp tục dùng danh
  sách All Solutions hiện tại.
- Truy vấn chọn best submission theo từng `user_id`, sau đó mới xếp hạng toàn
  bảng; không chỉ lấy 100 submission mới nhất như endpoint solutions hiện tại.
- Response trả metadata gồm `metric`, `greater_is_better`, `total_participants`
  và danh sách entries.
- Mỗi entry gồm `rank`, `username`, `avatar`, `score`, `attempts`,
  `best_submission_id` và `achieved_at`.
- Giới hạn/paginate kết quả khi số thành viên tăng; thứ hạng phải ổn định giữa
  các trang.
- Không trả file submission hoặc dữ liệu dự đoán của người thi khác.

Nếu cần bảng điểm tổng cho một contest trong tương lai, tạo trường/tầng
`contest_points` riêng. Không dùng điểm đã normalize đó để thay thế raw metric
của leaderboard từng bài.

#### 2.8. Giao diện

- Với Function Only, tab giữ tên **All Solutions** và hành vi hiện tại.
- Với CSV Judge, đổi tab thành **Leaderboard**.
- Phía trên bảng hiển thị rõ metric và chiều tối ưu, ví dụ:
  `Metric: RMSE · Lower is better` hoặc `Metric: Macro F1 · Higher is better`.
- Bảng gồm `Rank`, `Participant`, `Best score`, `Attempts`, `Achieved at`.
- Có podium/top-three nhẹ nhàng nhưng bảng vẫn là nguồn thông tin chính.
- Highlight hàng của người dùng đang đăng nhập.
- F1/Accuracy có thể định dạng phần trăm ở UI, nhưng API và database vẫn giữ
  giá trị gốc; tooltip nên hiển thị raw value đầy đủ.
- RMSE/MAE/Log Loss hiển thị số thập phân và không gắn ký hiệu phần trăm.
- Trạng thái trống giải thích rằng leaderboard sẽ xuất hiện sau submission CSV
  hợp lệ đầu tiên.

#### 2.9. Tiêu chí nghiệm thu

- Với RMSE, submission có `0.60` đứng trên `0.70`.
- Với F1, submission có `0.70` đứng trên `0.60`.
- Một người submit nhiều lần chỉ có một hàng và hàng đó dùng đúng best score.
- Khi hai best score bằng nhau, thời điểm đạt best score sớm hơn thắng tie-break.
- Submission failed/rejected và tài khoản admin không xuất hiện.
- Attempts phản ánh đúng số lượt submit của thành viên cho bài đó.
- Function Only All Solutions không bị thay đổi.

### P0 — Unarchive bài tập

#### 2.10. Backend

- Thêm endpoint tường minh, đề xuất `POST /api/admin/problems/:slug/unarchive`.
- Endpoint chỉ dành cho admin, kiểm tra bài tồn tại và hiện đang archived.
- Đặt `active=true`, cập nhật `updated_at` và trả về trạng thái mới.
- Không dùng thao tác Edit như cách ngầm unarchive; Edit và Unarchive phải có ý nghĩa riêng.

#### 2.11. Admin UI

- Bài active hiển thị nút Edit và Archive.
- Bài archived hiển thị nhãn Archived, nút Edit, Unarchive và Delete permanently.
- Có bộ lọc All / Active / Archived để dễ quản lý.
- Sau khi unarchive, bài xuất hiện lại ở AI Arena và có thể submit ngay.

#### 2.12. Tiêu chí nghiệm thu

- Archive giữ toàn bộ submissions và dữ liệu CSV.
- Unarchive khôi phục bài mà không làm thay đổi slug, dữ liệu hoặc lịch sử submit.
- Gọi unarchive nhiều lần không tạo trạng thái sai; API trả lỗi hoặc phản hồi idempotent rõ ràng.

### P0 — Xóa vĩnh viễn bài và lịch sử submit

Delete là thao tác phá hủy dữ liệu, phải tách biệt hoàn toàn với Archive.

#### 2.13. Hành vi mong muốn

Khi admin xóa vĩnh viễn một bài:

- Xóa toàn bộ submission có `problem_slug` tương ứng.
- Xóa record bài trong bảng `problems`.
- Nếu là bài CSV, xóa thư mục `csv-problems/<slug>` gồm config, ground truth, sample và dataset công khai.
- Thống kê profile, ranklist và số submission được cập nhật theo dữ liệu còn lại.
- Slug có thể được tái sử dụng sau khi xóa hoàn tất.

#### 2.14. Thiết kế an toàn

- Chỉ cho phép Delete permanently đối với bài đã Archive trước đó.
- UI hiển thị số submissions và số file/dung lượng sẽ bị xóa.
- Yêu cầu admin nhập đúng slug để xác nhận, không chỉ dùng hộp thoại Yes/No.
- Endpoint đề xuất: `DELETE /api/admin/problems/:slug/permanent`.
- Trong database, dùng transaction để xóa submissions trước rồi xóa problem.
- Việc xóa thư mục chỉ được thực hiện trên đường dẫn đã resolve và xác nhận nằm bên trong `CSV_PROBLEMS_DIR`; không dùng đường dẫn tùy ý từ request.
- Nếu xóa file thất bại sau khi database đã commit, ghi log rõ ràng và có cơ chế cleanup/retry; không được báo thành công im lặng.
- Ghi audit log tối thiểu gồm admin, slug, thời gian, số submissions và các file đã xóa.
- Backup production trước lần đầu triển khai tính năng này.

Ghi chú thiết kế database:

- Có thể tiếp tục xóa submissions tường minh trong transaction để hành vi dễ kiểm soát.
- Nếu bổ sung foreign key `submissions.problem_slug -> problems.slug ON DELETE CASCADE`, cần migration kiểm tra orphan rows trước khi tạo constraint.
- Dù dùng cascade, vẫn cần xử lý riêng dữ liệu trong Docker volume.

#### 2.15. Tiêu chí nghiệm thu

- Không thể xóa vĩnh viễn bài đang active.
- Xác nhận sai slug không thực hiện bất kỳ thay đổi nào.
- Sau khi xóa, API chi tiết bài trả 404 và không còn submission của bài trong My submissions/All Solutions.
- Ranklist và profile không còn tính kết quả của bài đã xóa.
- Với bài CSV, toàn bộ thư mục của slug đã được dọn sạch; các thư mục challenge khác không bị ảnh hưởng.
- Nếu một bước database lỗi, transaction rollback và bài/submissions vẫn nguyên vẹn.

### P1 — Cải thiện Profile Overview

#### 2.16. Mục tiêu UI

- Không bóp phần Overview vào cột quá hẹp khi bên cạnh là Edit account.
- Cho phần hero, overview và account editor có nhịp khoảng trắng thống nhất.
- Profile công khai và profile của chính mình dùng cùng hệ thống layout, nhưng chỉ chủ tài khoản thấy form chỉnh sửa.

#### 2.17. Bố cục đề xuất

Desktop:

- Hero profile ở hàng đầu, gồm avatar, identity và các stat cards.
- Overview nằm toàn chiều rộng ở hàng kế tiếp.
- Edit account nằm toàn chiều rộng bên dưới, hoặc dùng grid 2 cột chỉ khi viewport đủ rộng và Overview vẫn đạt chiều rộng tối thiểu hợp lý.
- Các trường overview dùng grid card 2–3 cột thay vì definition list bị nén.

Tablet/mobile:

- Chuyển về một cột.
- Stat cards tự wrap, không ép chữ xuống nhiều dòng.
- Avatar editor và form không tràn chiều ngang.

#### 2.18. Tiêu chí nghiệm thu

- Overview dễ đọc ở các viewport 1440 px, 1024 px, 768 px và 375 px.
- Không có card bị co quá hẹp, nội dung chồng lên nhau hoặc khoảng trống mất cân đối.
- Profile công khai không để lại khoảng trống do thiếu Edit account.
- Avatar và thống kê vẫn thẳng hàng, không làm hero cao bất thường.

## 3. Thứ tự triển khai đề xuất

1. Thêm leaderboard riêng cho CSV Judge, dùng best raw metric mỗi thành viên.
2. Thêm Unarchive và bộ lọc trạng thái trong Admin.
3. Thêm Delete permanently cùng transaction, xác nhận slug và cleanup dữ liệu CSV.
4. Cải thiện Profile Overview vì phạm vi nhỏ và ít phụ thuộc backend.
5. Xây mô hình metadata và upload/stream dataset cho AI Tracks.
6. Bổ sung Competition data UI và kiểm thử bảo mật download.
7. Chạy regression test, backup production rồi mới deploy.

## 4. Kiểm thử bắt buộc

### Backend/API

- Phân quyền admin cho archive, unarchive và permanent delete.
- Không lộ ground truth/config qua API công khai, path traversal hoặc tên file giả.
- Archive → Unarchive giữ nguyên submission.
- Archive → Delete xóa đúng bài, đúng submissions và đúng thư mục.
- Upload dataset mới, thay thế file, giữ file cũ khi không upload và từ chối file quá lớn.
- CSV Judge vẫn chấm được các task type và metric hiện có.
- Leaderboard chọn đúng best submission theo chiều của metric và loại admin.
- Tie-break theo thời điểm đạt best score hoạt động ổn định.

### Frontend

- Trạng thái/nút quản trị đúng với active và archived.
- Dialog xóa hiển thị hậu quả và bắt buộc nhập slug.
- Competition data chỉ hiển thị các file thực sự tồn tại.
- Download có loading/error state rõ ràng.
- CSV Judge hiển thị Leaderboard; Function Only vẫn hiển thị All Solutions.
- Leaderboard ghi rõ metric, Higher/Lower is better và highlight người hiện tại.
- Profile responsive trên desktop, tablet và mobile.

### Regression

- Function Only submission không bị ảnh hưởng.
- My submissions, All Solutions, Ranklist và public profile vẫn hoạt động.
- Bài CSV cũ không có train/test vẫn mở và submit được.
- Điểm raw metric trong lịch sử submission không bị thay đổi hoặc normalize.
- Docker volume tồn tại qua rebuild/restart.

## 5. Triển khai production

- Tạo backup PostgreSQL và volume `csvdata` trước khi deploy.
- Nếu thêm migration foreign key, chạy truy vấn phát hiện submission mồ côi trước.
- Build và chạy test ở local/CI trước khi cập nhật VPS.
- Deploy bằng Docker Compose, kiểm tra health endpoint và logs của `auth-api`, `csv-judge`, `rust-worker`, `web`.
- Thử một bài CSV mẫu từ tải dataset → tạo prediction → upload → nhận điểm.
- Thử archive/unarchive trên bài test; chỉ thử permanent delete với dữ liệu thử nghiệm đã backup.
- Theo dõi dung lượng ổ đĩa và đặt chính sách dọn backup/dataset cũ.

## 6. Ngoài phạm vi giai đoạn này

Các ý tưởng có thể làm sau khi luồng cơ bản ổn định:

- Dataset versioning và lịch sử thay đổi file.
- Public/private leaderboard split theo hai phần ground truth giống Kaggle.
- Giới hạn số lượt submit theo ngày hoặc cooldown.
- Deadline, team participation và contest-scoped leaderboard.
- Object storage tương thích S3 khi dung lượng dataset vượt khả năng VPS.
- Quét malware và checksum cho file upload lớn.

