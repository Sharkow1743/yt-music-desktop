(function () {
    const sidebar = document.querySelector('#mini-guide');
    const isHidden = !sidebar || getComputedStyle(sidebar).display === 'none';

    if (isHidden) {
    document.querySelector('#button')?.click();
    }
})();