// Initialize video background for Electron
document.addEventListener('DOMContentLoaded', function() {
    const video = document.getElementById('backgroundVideo');
    if (video) {
        // Force video playback
        video.play().catch(function(error) {
            // Try to play after user interaction
            document.addEventListener('click', function() {
                video.play().catch(function(err) {
                });
            }, { once: true });
        });
    }
});
