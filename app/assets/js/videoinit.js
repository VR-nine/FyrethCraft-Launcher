// Инициализация видеофона для Electron
document.addEventListener('DOMContentLoaded', function() {
    const video = document.getElementById('backgroundVideo');
    if (video) {
        // Принудительно запускаем видео
        video.play().catch(function(error) {
            // Попробуем запустить после взаимодействия пользователя
            document.addEventListener('click', function() {
                video.play().catch(function(err) {
                });
            }, { once: true });
        });
    }
});
