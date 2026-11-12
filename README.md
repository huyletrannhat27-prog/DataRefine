# DataRefine

Ứng dụng web xử lý dữ liệu dạng bảng, có thể chạy trên máy hoặc triển khai trên Render. File có cấu trúc đã được hỗ trợ sẽ được xử lý tự động. File thuộc dạng mới vào hàng chờ và được chạy lại khi admin kích hoạt mô hình phù hợp.

## Chạy trên máy

Cần Node.js 24. Không cần cài thư viện hay kết nối dịch vụ bên ngoài.

- Trên Windows, nhấp đúp **Khoi-dong.cmd**, hoặc mở terminal tại thư mục repo và chạy **npm start**.
- Mở **http://127.0.0.1:4318** trong trình duyệt.
- Khi vào **Quản trị**, nhập mã hiển thị trong cửa sổ đang chạy server hoặc mã bạn đặt trong biến môi trường.
- File gốc, CSV kết quả và báo cáo được lưu trong **.datarefine/datasets/**. Thông tin công việc, thông báo và mô hình được lưu trong **.datarefine/state.json**. Git bỏ qua thư mục này. Đóng cửa sổ server hoặc nhấn **Ctrl+C** để dừng.

Có thể đặt các biến môi trường **DATAREFINE_PORT**, **DATAREFINE_STATE_DIR** và **DATAREFINE_ADMIN** để thay đổi cổng, thư mục dữ liệu và mã quản trị.

## Deploy lên Render

1. Trong [Render Dashboard](https://dashboard.render.com/), chọn **New → Web Service**. Kết nối GitHub, chọn repo **DataRefine** và nhánh **main**.
2. Chọn runtime **Node**, để trống **Root Directory**, đặt **Build Command** là `npm install` và **Start Command** là `npm start`.
3. Trong **Environment Variables**, đặt `NODE_VERSION=24.18.0` và `DATAREFINE_ADMIN` bằng một mã quản trị mạnh do bạn tự chọn. Render cấp sẵn `PORT` và `RENDER_EXTERNAL_URL`.
4. Để demo với dữ liệu mẫu, chọn **Free**. Để giữ dữ liệu qua lần khởi động lại hoặc deploy, dùng instance trả phí có **Persistent Disk** gắn tại `/var/data` và đặt `DATAREFINE_STATE_DIR=/var/data`. Dung lượng đĩa phải đủ cho file gốc, kết quả, báo cáo và phần xử lý tạm.
5. Khi dịch vụ báo **Live**, mở URL `onrender.com` do Render cấp, chọn mẫu **Bán hàng** và kiểm tra CSV kết quả. Vào **Quản trị** bằng mã đã đặt ở bước 3.

Luồng xử lý 10 GiB đã được kiểm thử cục bộ. Hãy thử tăng dần kích thước file trên Render để kiểm tra việc truyền qua mạng và dung lượng đĩa của instance thực tế.

[Hướng dẫn Web Service](https://render.com/docs/web-services) · [Hướng dẫn Persistent Disk](https://render.com/docs/disks)

## Thử toàn bộ luồng

1. Chọn mẫu **Bán hàng** ở trang chính. Web tạo CSV kết quả và báo cáo, trong đó có ô đã ước lượng, ô cần kiểm tra, ngày đã chuẩn hóa và dòng trùng đã loại.
2. Chọn mẫu **Kho hàng**. Khi chưa kích hoạt mô hình kho, file sẽ vào hàng chờ. Cả người dùng và admin thấy thông báo về ô trống.
3. Vào **Quản trị**, chọn **Dùng mẫu kho hàng → Huấn luyện và đánh giá**. Kết quả so sánh sai số tuyệt đối trung bình (MAE) của mô hình với phương pháp điền trung vị.
4. Chọn **Kích hoạt**. Web tự chạy lại file kho đang chờ. Quay về trang chính để tải CSV kết quả. File kho cùng cấu trúc tải lên sau đó sẽ được xử lý tự động.

Các file trong **samples/** cũng có thể dùng để thử bằng nút **Chọn file dữ liệu**. Để thử lại luồng chờ sau khi đã kích hoạt mô hình kho, hãy khởi động ứng dụng với **DATAREFINE_STATE_DIR** trỏ tới một thư mục dữ liệu mới.

## Nhập nhiều file và file lớn

Chọn hoặc kéo thả nhiều file cùng lúc. Web tải lên lần lượt, sau đó xử lý từng file trong hàng đợi riêng. Mỗi file có trạng thái và kết quả riêng. Kết quả luôn tải xuống dưới dạng CSV, còn file gốc được giữ nguyên.

| Định dạng UTF-8 | Cấu trúc đầu vào |
| --- | --- |
| CSV | Có tiêu đề. Tự nhận dấu phẩy, chấm phẩy, tab hoặc dấu gạch đứng. |
| TSV | Có tiêu đề và dùng tab để phân tách. |
| TXT | Dữ liệu dạng bảng có tiêu đề. Tự nhận dấu phẩy, chấm phẩy, tab hoặc dấu gạch đứng. |
| JSONL, NDJSON | Mỗi dòng là một object phẳng. Khai báo đủ cột ở object đầu tiên. Trường thiếu hoặc có giá trị null được tính là ô trống. |

- Tối đa **10 GiB mỗi file**, từ 2 đến 128 cột, mỗi bản ghi tối đa khoảng 1 Mi ký tự. File được đọc và ghi theo từng khối. Dung lượng đĩa cần có còn phụ thuộc vào file gốc, CSV kết quả, báo cáo lỗi và chỉ mục tạm để kiểm tra dòng trùng.
- Mở trang lịch sử để theo dõi tiến độ. Có thể đóng trình duyệt sau khi tải lên hoàn tất nếu server vẫn chạy. Nếu server khởi động lại, các file đã nhận xong nhưng chưa xử lý xong được xử lý lại từ đầu.
- Bộ file huấn luyện và kiểm thử của admin vẫn là CSV mẫu nhỏ, tối đa 200 KB và 1.200 bản ghi mỗi file. Giới hạn 10 GiB áp dụng cho file đưa vào xử lý.
- Hệ thống nhận dạng theo tập tên cột đã chuẩn hóa. Với mỗi cấu trúc, mô hình KNN ước lượng giá trị thiếu cho một cột số mục tiêu. Các ô chưa đủ dữ liệu để ước lượng được đánh dấu trong báo cáo.
- Admin huấn luyện từ CSV có giá trị đã xác minh và dùng một CSV khác để kiểm thử. Mô hình phải ước lượng được ít nhất 60% mẫu kiểm thử, đồng thời MAE phải bằng hoặc thấp hơn phương pháp trung vị và mô hình hiện tại nếu có. MAE tính trung vị cho mẫu mô hình từ chối. File kết quả giữ nguyên các ô bị từ chối và ghi chúng trong báo cáo.
- Dữ liệu bán hàng và kho là dữ liệu giả lập để thử luồng. Thông báo xuất hiện trong web. Lịch sử người dùng gắn với trình duyệt.
