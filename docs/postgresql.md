
# PostgreSQL cho DataRefine

Khi có biến môi trường DATABASE_URL, server dùng PostgreSQL để lưu file gốc, file kết quả, báo cáo, dữ liệu huấn luyện và trạng thái ứng dụng. Trên máy, nếu bỏ trống biến này, server vẫn dùng thư mục .datarefine như trước.

## Kết nối với Render

1. Trong Render Dashboard, tạo một PostgreSQL database cùng workspace và cùng region với Web Service DataRefine.
2. Mở database, vào **Connect**, sao chép **Internal Database URL**.
3. Trong **Environment** của Web Service, thêm **DATABASE_URL** với giá trị là URL vừa sao chép. Giữ cấu hình DATAREFINE_ADMIN đang dùng. Đặt Build Command là **npm ci** và Start Command là **npm start**.
4. Triển khai commit có hỗ trợ PostgreSQL. Server tự áp dụng **sql/001-postgres.sql** khi khởi động. Log **DataRefine storage: PostgreSQL** xác nhận đã khởi tạo database.
5. Upload một CSV mẫu. Sau khi server khởi động lại, kiểm tra file gốc và dữ liệu huấn luyện vẫn có thể tải xuống.

DATABASE_URL chứa mật khẩu database. Chỉ đặt nó trong Environment của Render hoặc môi trường chạy cục bộ. Nếu trước đó bản web dùng lưu file cục bộ, hãy tải xuống các file cần giữ trước khi đổi backend hoặc redeploy. PostgreSQL khởi tạo một kho mới và không tự nhập dữ liệu từ ổ tạm của bản deploy cũ.

- **datarefine_state** lưu thông tin dataset, hàng đợi, báo cáo trạng thái, mô hình và liên kết tới bộ huấn luyện.
- **datarefine_files** và **datarefine_file_chunks** lưu nội dung theo khối tối đa 1 MiB. File chỉ được đưa vào hàng xử lý sau khi tất cả khối của file gốc đã ghi thành công.
- PostgreSQL Free của Render chỉ có 1 GB và hết hạn sau 30 ngày. Với file cỡ 10 GiB cần gói có đủ dung lượng cho file gốc, các tập tách, kết quả và tăng trưởng dữ liệu. Giới hạn upload trong ứng dụng không thay thế giới hạn của Render hoặc database.

[Tạo và kết nối Render Postgres](https://render.com/docs/postgresql-creating-connecting) · [Giới hạn gói miễn phí](https://render.com/docs/free#free-postgres)

## Huấn luyện từ một dataset lớn

Trong **Quản trị**, chọn một file và bấm **Tải lên và chia 70 / 15 / 15**. Server chấp nhận các định dạng bảng UTF-8 giống trang người dùng, tối đa 10 GiB mỗi file. Dòng có cùng nội dung sau chuẩn hóa luôn vào cùng một tập. Tỷ lệ tính theo nhóm nên là xấp xỉ, đặc biệt với file nhỏ hoặc có nhiều dòng lặp.

Khi trạng thái là **Đã chia**, tải riêng CSV train, validation hoặc test, hoặc bấm **Dùng để huấn luyện** và chọn phương pháp. KNN có thể điền cột số, nhãn hoặc ngày ISO / ngày-tháng-năm có năm bốn chữ số. Train dùng để xây mô hình. Validation so sai số với trung vị cho số và ngày, hoặc nhãn phổ biến nhất cho nhãn. Nếu có mô hình hiện tại cùng cột và kiểu mục tiêu, hệ thống cũng so với mô hình đó. Kết quả trên tập test được báo riêng.

Ba CSV chứa toàn bộ bản ghi. Để giới hạn RAM và thời gian dự đoán của KNN, server lấy tối đa 2.000 dòng train, 600 dòng validation và 600 dòng test để tính toán. Bản ghi lấy mẫu có ngân sách 1 KiB. Hệ thống giữ các ô ngắn trước. Các ô dài vượt ngân sách vẫn nằm trong CSV đầy đủ. Chọn dataset có đủ bản ghi hợp lệ cho cột mục tiêu và các cột đầu vào.

Với file đã vào **Hàng chờ xử lý**, admin có thể bấm **Đưa vào huấn luyện** để chia file gốc mà không phải tải xuống rồi tải lại. Nếu dataset thiếu mẫu hoặc chỉ cần chuẩn hóa định dạng, bấm **Tạo quy tắc làm sạch** rồi kích hoạt. Quy tắc chuẩn hóa ngày ở các cột ngày thông dụng, bỏ dòng trùng và báo ô trống để kiểm tra.
