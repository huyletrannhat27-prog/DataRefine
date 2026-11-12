# Mô hình DataRefine từ Kaggle

DataRefine nạp các mô hình dưới đây khi chưa có cấu hình cho cùng cấu trúc cột. Các file đang chờ cùng cấu trúc được đưa vào hàng xử lý lại. Tập test độc lập với train và validation.

| Dataset | Cột được điền | Kết quả test |
| --- | --- | --- |
| [Iris Species](https://www.kaggle.com/datasets/uciml/iris) | species | 15% sai số phân loại trên 20 dòng |
| [Red Wine Quality](https://www.kaggle.com/datasets/uciml/red-wine-quality-cortez-et-al-2009) | quality | MAE 0,55 điểm trên 211 dòng |
| [Palmer Penguins](https://www.kaggle.com/datasets/parulpandey/palmer-archipelago-antarctica-penguin-data) | species | 3,922% sai số phân loại trên 51 dòng |
| [OpenPowerlifting Meets, phiên bản 1](https://www.kaggle.com/datasets/open-powerlifting/powerlifting-database/versions/1) | meetcountry | 0,509% sai số phân loại trên 393 dòng |

Tỷ lệ mẫu test được KNN ước lượng lần lượt là 100%, 94,3%, 100% và 94,7%. Điểm test dùng giá trị cơ sở cho mẫu mô hình từ chối dự đoán. Khi xử lý file, DataRefine đánh dấu những ô đó để người dùng kiểm tra.

## Tái tạo mô hình

Tải bản lưu trữ của từng dataset từ các trang Kaggle trên. Giải nén đúng các CSV sau vào một thư mục làm việc.

- iris/Iris.csv
- wine/winequality-red.csv
- penguins/penguins_size.csv
- powerlifting/meets.csv

Chạy **node scripts/train-kaggle.mjs <thư mục dữ liệu>** từ repo. Script chia theo nhóm bản ghi bằng hàm băm, thử các bộ cột đầu vào trên validation và lưu mô hình đạt tiêu chí vào **models/kaggle-profiles.json**. Mỗi mô hình lưu SHA-256 của CSV nguồn.

Iris do R. A. Fisher công bố qua [UCI](https://archive.ics.uci.edu/dataset/53/iris). Red Wine Quality do P. Cortez và cộng sự công bố qua [UCI](https://archive.ics.uci.edu/dataset/186/wine+quality). Cả hai dùng giấy phép CC BY 4.0. Palmer Penguins dùng CC0 và dựa trên dữ liệu của Kristen Gorman cùng Palmer Station LTER, công bố trong [Gorman và cộng sự, 2014](https://doi.org/10.1371/journal.pone.0090081). Dữ liệu giải đấu được cung cấp bởi [OpenPowerlifting](https://old.openpowerlifting.org/data.html) và thuộc phạm vi công cộng.
