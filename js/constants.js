// Shared vocabulary for the catalog and the admin. Edit these lists to fit
// your closet; items already saved keep whatever value they were given.

// Sizes in growth order, grouped into the bands shown under the size ruler.
export const SIZE_BANDS = [
  { band: 'Baby', sizes: ['Preemie', 'NB', '0-3M', '3-6M', '6-9M', '9-12M', '12-18M', '18-24M'] },
  { band: 'Toddler', sizes: ['2T', '3T', '4T', '5T'] },
  { band: 'Kids', sizes: ['6', '7', '8', '10', '12', '14', '16'] },
  { band: 'Teen', sizes: ['XS', 'S', 'M', 'L', 'XL'] },
];

export const SIZES = SIZE_BANDS.flatMap((b) => b.sizes);

export const CATEGORIES = [
  'Tops',
  'Bottoms',
  'Dresses & skirts',
  'One-pieces & sets',
  'Outerwear',
  'Sleepwear',
  'Underwear & socks',
  'Swimwear',
  'Accessories',
];

export const GENDERS = ['Boys', 'Girls', 'Unisex'];

export const CONDITIONS = ['New with tags', 'Like new', 'Gently used'];

export const REQUEST_STATUSES = ['pending', 'approved', 'fulfilled', 'denied'];

export const PHOTO_BUCKET = 'item-photos';

// Client-side photo processing before upload.
export const PHOTO_FULL = { maxSize: 1200, quality: 0.8 };
export const PHOTO_THUMB = { maxSize: 240, quality: 0.75 };

export const DEFAULT_SETTINGS = { org_name: 'Clothing Closet', max_items_per_request: 5 };
