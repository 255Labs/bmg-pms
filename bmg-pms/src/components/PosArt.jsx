// Items without a photo get a clean monogram tile (like most professional tills): the item's initials on a
// muted colour that follows its kind — drinks, food, services, activities — so the menu still scans quickly.
const RULES = [
  [/coffee|tea|chai|latte|cappuc|espresso|kahawa/i, 'coffee'],
  [/wine|champagne|prosecco/i, 'wine'],
  [/cocktail|juice|smoothie|mocktail|lemonade|passion/i, 'glass'],
  [/beer|lager|safari|kilimanjaro|serengeti|soda|coke|fanta|sprite|water|maji|tusker|bottle|drink|spirit|whisk|gin|vodka/i, 'bottle'],
  [/burger|sandwich|wrap|toast/i, 'burger'],
  [/pizza/i, 'pizza'],
  [/mishkaki|skewer|kebab|chicken|kuku|nyama|beef|goat|meat|grill|steak|chips/i, 'skewer'],
  [/fish|tilapia|samaki|prawn|seafood|octopus|calamari/i, 'fish'],
  [/pilau|rice|wali|biriani|biryani|ugali|pasta|noodle/i, 'rice'],
  [/breakfast|egg|omelet|pancake|chapati|mandazi/i, 'breakfast'],
  [/cake|dessert|ice cream|sweet|fruit/i, 'cake'],
  [/salad|vegetable|veg/i, 'salad'],
  [/laundry|wash|iron|dry clean|shirt|trouser/i, 'laundry'],
  [/pool table|billiard|snooker|darts|games|table tennis|8.?ball/i, 'pool'],
  [/gym|fitness|weights|trainer/i, 'gym'],
  [/swim|pool pass|day pass|aqua/i, 'swim'],
  [/spa|massage|sauna|steam|facial|nail|beauty/i, 'spa'],
  [/tour|trip|safari tour|boat|snorkel|dhow|excursion|transfer/i, 'tour'],
  [/membership|pass|ticket|entry|event/i, 'ticket'],
];
export const artFor = (text) => RULES.find(([re]) => re.test(text))?.[1] ?? 'dish';

const TONE = { coffee: 'drink', wine: 'drink', glass: 'drink', bottle: 'drink', burger: 'food', pizza: 'food', skewer: 'food', fish: 'food', rice: 'food',
  breakfast: 'food', cake: 'food', salad: 'food', dish: 'food', laundry: 'service', spa: 'service', pool: 'activity', gym: 'activity', swim: 'activity',
  tour: 'activity', ticket: 'activity' };
const KIND = { drink: 'Drink', food: 'Food', service: 'Service', activity: 'Activity' };

export default function PosArt({ item, outletType }) {
  const tone = TONE[artFor(`${item.name} ${item.group_name ?? ''} ${outletType ?? ''}`)] ?? 'food';
  const words = String(item.name ?? '').replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/).filter(Boolean);
  const initials = ((words[0]?.[0] ?? '') + (words[1]?.[0] ?? words[0]?.[1] ?? '')).toUpperCase();
  return (
    <span className={`pos-mono tone-${tone}`} aria-hidden="true">
      <span className="pos-mono-letters">{initials || '•'}</span>
      <span className="pos-mono-kind">{item.group_name || KIND[tone]}</span>
    </span>
  );
}
